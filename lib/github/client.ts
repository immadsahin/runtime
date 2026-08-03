import { requireEnv } from "@/lib/env";

/** A GitHub repository normalized to the fields Runtime persists. */
export type GitHubRepository = {
  githubRepoId: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  htmlUrl: string;
  pushedAt: string | null;
};

type GitHubApiRepository = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  html_url: string;
  pushed_at: string | null;
};

/**
 * Deliberately generic error: callers may display its message without leaking
 * a GitHub response body, token metadata, or request URL.
 */
export class GitHubSyncError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubSyncError";
  }
}

const GITHUB_API_URL = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "runtime-v0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHub(url: URL, token: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: githubHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("GitHub repository request failed", error);
    throw new GitHubSyncError("Could not reach GitHub. Please try again.");
  }
}

function normalizeRepository(repo: GitHubApiRepository): GitHubRepository {
  if (
    !Number.isSafeInteger(repo.id) ||
    repo.id <= 0 ||
    !repo.full_name ||
    !repo.name ||
    !repo.owner?.login ||
    !repo.html_url
  ) {
    throw new GitHubSyncError("GitHub returned an invalid repository record.");
  }

  return {
    githubRepoId: repo.id,
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch || "main",
    private: Boolean(repo.private),
    language: repo.language,
    description: repo.description,
    htmlUrl: repo.html_url,
    pushedAt: repo.pushed_at,
  };
}

/**
 * Retrieves repositories visible to the configured personal access token.
 *
 * GitHub OAuth in Supabase establishes who may use Runtime. The PAT remains
 * server-only and authorizes repository access, clone, push, and PR actions.
 */
export async function listGitHubRepositories(
  expectedOwnerLogin: string,
): Promise<GitHubRepository[]> {
  const token = requireEnv("GITHUB_PAT");
  const repositories: GitHubRepository[] = [];

  const identity = await fetchGitHub(new URL("/user", GITHUB_API_URL), token);
  if (!identity.ok) {
    console.error("GitHub token identity request was rejected", {
      status: identity.status,
    });
    throw new GitHubSyncError("GitHub could not authorize the configured token.");
  }

  let tokenLogin: unknown;
  try {
    tokenLogin = ((await identity.json()) as { login?: unknown }).login;
  } catch (error) {
    console.error("GitHub returned an unreadable token identity", error);
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }

  if (typeof tokenLogin !== "string") {
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }
  if (tokenLogin.toLowerCase() !== expectedOwnerLogin.toLowerCase()) {
    throw new GitHubSyncError(
      "The configured GitHub token belongs to a different account.",
    );
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL("/user/repos", GITHUB_API_URL);
    url.searchParams.set(
      "affiliation",
      "owner,collaborator,organization_member",
    );
    url.searchParams.set("sort", "pushed");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));

    const response = await fetchGitHub(url, token);

    if (!response.ok) {
      console.error("GitHub repository request was rejected", {
        status: response.status,
      });
      throw new GitHubSyncError(
        response.status === 401 || response.status === 403
          ? "GitHub could not authorize the configured token."
          : "GitHub could not list repositories. Please try again.",
        response.status,
      );
    }

    let pageRepositories: GitHubApiRepository[];
    try {
      pageRepositories = (await response.json()) as GitHubApiRepository[];
    } catch (error) {
      console.error("GitHub returned an unreadable repository response", error);
      throw new GitHubSyncError("GitHub returned an invalid response.");
    }

    if (!Array.isArray(pageRepositories)) {
      throw new GitHubSyncError("GitHub returned an invalid response.");
    }

    repositories.push(...pageRepositories.map(normalizeRepository));

    if (pageRepositories.length < PER_PAGE) return repositories;
  }

  throw new GitHubSyncError(
    "Repository sync stopped after 10,000 repositories. Narrow the GitHub token's access and try again.",
  );
}
