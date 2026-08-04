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
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubSyncError";
    this.status = status;
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
  return githubRequest("GET", url, token);
}

async function githubRequest(
  method: "GET" | "POST",
  url: URL,
  token: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        ...githubHeaders(token),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("GitHub request failed", error);
    throw new GitHubSyncError("Could not reach GitHub. Please try again.");
  }
}

/**
 * The GitHub login that owns the configured token, read from `/user`. Shared
 * by repository sync and the M9 publish path so both enforce the same
 * "token belongs to the Runtime owner" invariant.
 */
async function fetchTokenLogin(token: string): Promise<string> {
  const identity = await fetchGitHub(new URL("/user", GITHUB_API_URL), token);
  if (!identity.ok) {
    console.error("GitHub token identity request was rejected", {
      status: identity.status,
    });
    throw new GitHubSyncError("GitHub could not authorize the configured token.");
  }

  let login: unknown;
  try {
    login = ((await identity.json()) as { login?: unknown }).login;
  } catch (error) {
    console.error("GitHub returned an unreadable token identity", error);
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }

  if (typeof login !== "string") {
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }
  return login;
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

  const tokenLogin = await fetchTokenLogin(token);
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

// ---------------------------------------------------------------------------
// M9 publish: verify the token owner, then find-or-create one pull request.
// ---------------------------------------------------------------------------

export type WorkspacePullRequestRef = { number: number; url: string };

/**
 * Re-confirm that the configured PAT still belongs to the signed-in Runtime
 * owner, immediately before it is used to push a branch and open a PR.
 */
export async function verifyTokenOwner(expectedOwnerLogin: string): Promise<void> {
  const token = requireEnv("GITHUB_PAT");
  const tokenLogin = await fetchTokenLogin(token);
  if (tokenLogin.toLowerCase() !== expectedOwnerLogin.toLowerCase()) {
    throw new GitHubSyncError(
      "The configured GitHub token belongs to a different account.",
    );
  }
}

/**
 * Return the existing open PR for `headBranch`, or create one. Making this
 * idempotent (lookup before create, and re-lookup on GitHub's 422 for an
 * already-existing PR) lets the publish route retry safely.
 */
export async function findOrCreatePullRequest(input: {
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<WorkspacePullRequestRef> {
  const token = requireEnv("GITHUB_PAT");
  const [owner] = input.repoFullName.split("/");

  const existing = await findOpenPullRequest(input, owner, token);
  if (existing) return existing;

  const response = await githubRequest(
    "POST",
    new URL(`/repos/${input.repoFullName}/pulls`, GITHUB_API_URL),
    token,
    {
      title: input.title,
      head: input.headBranch,
      base: input.baseBranch,
      body: input.body,
    },
  );

  if (response.status === 422) {
    // A concurrent publish, or "no commits between base and head".
    const retried = await findOpenPullRequest(input, owner, token);
    if (retried) return retried;
    throw new GitHubSyncError(
      "GitHub could not open a pull request. Ensure the branch has commits that differ from the base.",
      422,
    );
  }
  if (!response.ok) {
    console.error("GitHub pull request creation was rejected", {
      status: response.status,
    });
    throw new GitHubSyncError(
      response.status === 401 || response.status === 403
        ? "GitHub could not authorize the configured token."
        : "GitHub could not open a pull request. Please try again.",
      response.status,
    );
  }
  return toPullRequestRef(await readJson(response));
}

async function findOpenPullRequest(
  input: { repoFullName: string; headBranch: string; baseBranch: string },
  owner: string,
  token: string,
): Promise<WorkspacePullRequestRef | null> {
  const url = new URL(`/repos/${input.repoFullName}/pulls`, GITHUB_API_URL);
  url.searchParams.set("head", `${owner}:${input.headBranch}`);
  url.searchParams.set("base", input.baseBranch);
  url.searchParams.set("state", "open");

  const response = await fetchGitHub(url, token);
  if (!response.ok) {
    console.error("GitHub pull request lookup was rejected", {
      status: response.status,
    });
    throw new GitHubSyncError(
      "GitHub could not look up existing pull requests. Please try again.",
      response.status,
    );
  }
  const list = await readJson(response);
  if (!Array.isArray(list) || list.length === 0) return null;
  return toPullRequestRef(list[0]);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    console.error("GitHub returned an unreadable response", error);
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }
}

function toPullRequestRef(record: unknown): WorkspacePullRequestRef {
  const pr = (record ?? {}) as { number?: unknown; html_url?: unknown };
  if (
    typeof pr.number !== "number" ||
    !Number.isInteger(pr.number) ||
    typeof pr.html_url !== "string"
  ) {
    throw new GitHubSyncError("GitHub returned an invalid pull request record.");
  }
  return { number: pr.number, url: pr.html_url };
}
