/**
 * The one place all Git behavior lives. Providers supply a `GitExec` capability
 * (how to run a process in their environment); every Git flow — mirror, fetch,
 * worktree, status, diff, commit, push — is implemented here exactly once.
 *
 * Design notes:
 * - Commands are argv arrays, never shell strings: no quoting, no injection.
 * - Working directory is passed as `git -C <dir>` (not the exec's cwd) so a
 *   command is self-contained regardless of how a provider spawns it.
 * - Authentication uses Git's inline credential helper with the token in the
 *   environment (`RUNTIME_GIT_TOKEN`) — never in argv, never in a temp file,
 *   never persisted in the remote URL. Works the same for a local `spawn` and a
 *   remote `sandbox.exec`.
 */

import type { ChangedFile } from "@/lib/runtime/types";

export type GitExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitExecOptions = {
  /** Extra environment for this invocation (e.g. the credential token). */
  env?: Record<string, string>;
};

/** How a provider runs one process in its environment. */
export type GitExec = (
  argv: string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

// ---------------------------------------------------------------------------
// Pure helpers (previously duplicated across local and modal providers)
// ---------------------------------------------------------------------------

/** Filesystem-safe worktree directory name for a branch. */
export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Reject traversal, absolute paths, and Git pathspec magic before using a
 * caller-supplied path as a Git argument. */
export function isSafeRelativePath(filePath: string): boolean {
  return (
    Boolean(filePath) &&
    !filePath.includes("\0") &&
    !filePath.startsWith("/") &&
    !filePath.startsWith(":") &&
    filePath
      .split(/[\\/]/)
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function parseChangedFiles(output: string): ChangedFile[] {
  const entries = output.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    // porcelain v1 -z emits the original name as the next field for R/C.
    if (code.includes("R") || code.includes("C")) index += 1;
    files.push({
      path: filePath,
      status:
        code === "??"
          ? "untracked"
          : code.includes("A")
            ? "added"
            : code.includes("D")
              ? "deleted"
              : code.includes("R") || code.includes("C")
                ? "renamed"
                : "modified",
      additions: 0,
      deletions: 0,
    });
  }
  return files.slice(0, 500);
}

export function limitText(value: string, maxBytes: number): string {
  return Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n\n… diff truncated by Runtime …`;
}

// ---------------------------------------------------------------------------
// Internal command runner + auth
// ---------------------------------------------------------------------------

async function git(
  exec: GitExec,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await exec(["git", ...args], options);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed (${result.exitCode}): ${
        result.stderr || result.stdout || "no output"
      }`,
    );
  }
  return result.stdout;
}

/**
 * `-c` args that make Git authenticate with `x-access-token:<token>` where the
 * token comes from `RUNTIME_GIT_TOKEN` in the environment. The empty first
 * helper clears any inherited helper so only ours runs.
 */
const AUTH_CONFIG: string[] = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { test "$1" = get && echo "username=x-access-token" && echo "password=$RUNTIME_GIT_TOKEN"; }; f',
];

function authOptions(
  token: string | undefined,
  base?: GitExecOptions,
): GitExecOptions {
  if (!token) return base ?? {};
  return { env: { ...(base?.env ?? {}), RUNTIME_GIT_TOKEN: token } };
}

const remoteUrl = (repoFullName: string) =>
  `https://github.com/${repoFullName}.git`;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Full clone into `dir` (source of truth for the current local/modal flow). */
export async function cloneRepo(
  exec: GitExec,
  input: { repoFullName: string; dir: string; token?: string },
): Promise<void> {
  const remote = remoteUrl(input.repoFullName);
  await git(
    exec,
    [...AUTH_CONFIG, "clone", remote, input.dir],
    authOptions(input.token),
  );
}

/**
 * Bare mirror for the shared Runtime Computer layout (repo.git + worktrees).
 *
 * The remote's branches are kept in `refs/remotes/origin/*`, NOT local heads,
 * so a worktree can branch off `origin/<base>` and the only local `refs/heads`
 * are the per-workspace branches. `git clone --bare` puts branches directly in
 * `refs/heads` with no `origin/*`, which the agent's `worktree add … origin/<base>`
 * cannot resolve ("invalid reference") — so we init an empty bare repo, add the
 * remote (which sets the standard `+refs/heads/*:refs/remotes/origin/*` refspec
 * that `fetchMirror` then reuses), and fetch.
 */
export async function cloneMirror(
  exec: GitExec,
  input: { repoFullName: string; dir: string; token?: string },
): Promise<void> {
  const remote = remoteUrl(input.repoFullName);
  await git(exec, ["init", "--bare", input.dir]);
  await git(exec, ["-C", input.dir, "remote", "add", "origin", remote]);
  await git(
    exec,
    [
      "-C",
      input.dir,
      ...AUTH_CONFIG,
      "fetch",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ],
    authOptions(input.token),
  );
}

/** Fetch updates into a bare mirror. */
export async function fetchMirror(
  exec: GitExec,
  input: { repoDir: string; token?: string },
): Promise<void> {
  await git(
    exec,
    ["-C", input.repoDir, ...AUTH_CONFIG, "fetch", "--prune", "origin"],
    authOptions(input.token),
  );
}

/** Create a worktree on a new branch from `baseRef` (e.g. `origin/main`). */
export async function addWorktree(
  exec: GitExec,
  input: {
    repoDir: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  },
): Promise<void> {
  await git(exec, [
    "-C",
    input.repoDir,
    "worktree",
    "add",
    "-b",
    input.branch,
    input.worktreePath,
    input.baseRef,
  ]);
}

/** Remove a worktree (and prune its administrative files). */
export async function removeWorktree(
  exec: GitExec,
  input: { repoDir: string; worktreePath: string },
): Promise<void> {
  await git(exec, [
    "-C",
    input.repoDir,
    "worktree",
    "remove",
    "--force",
    input.worktreePath,
  ]);
}

/** Changed files in a worktree, including untracked. */
export async function listChangedFiles(
  exec: GitExec,
  input: { worktree: string },
): Promise<ChangedFile[]> {
  const output = await git(exec, [
    "-C",
    input.worktree,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseChangedFiles(output);
}

/** Bounded, text-only diff for one changed file, with membership + path safety. */
export async function readFileDiff(
  exec: GitExec,
  input: { worktree: string; path: string; maxBytes?: number },
): Promise<string> {
  if (!isSafeRelativePath(input.path)) {
    throw new Error("Invalid changed file path");
  }
  const changed = await listChangedFiles(exec, { worktree: input.worktree });
  const file = changed.find((f) => f.path === input.path);
  if (!file) throw new Error("File is not part of this workspace change set");
  if (file.status === "untracked") {
    return "This untracked file has no Git diff yet.";
  }
  const diff = await git(exec, [
    "-C",
    input.worktree,
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    input.path,
  ]);
  return limitText(diff, input.maxBytes ?? 200_000);
}

/** `git add -A && git commit` as the given author; returns the new SHA. */
export async function commitAll(
  exec: GitExec,
  input: {
    worktree: string;
    message: string;
    author: { name: string; email: string };
  },
): Promise<{ sha: string }> {
  const env = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  await git(exec, ["-C", input.worktree, "add", "-A"], { env });
  await git(exec, ["-C", input.worktree, "commit", "-m", input.message], {
    env,
  });
  const sha = (
    await git(exec, ["-C", input.worktree, "rev-parse", "HEAD"])
  ).trim();
  return { sha };
}

/** Push the branch to origin using an operation-scoped token; no hooks. */
export async function pushBranch(
  exec: GitExec,
  input: {
    worktree: string;
    repoFullName: string;
    branch: string;
    token: string;
  },
): Promise<void> {
  const remote = remoteUrl(input.repoFullName);
  await git(exec, ["-C", input.worktree, "remote", "set-url", "origin", remote]);
  await git(
    exec,
    [
      "-C",
      input.worktree,
      "-c",
      "core.hooksPath=/dev/null",
      ...AUTH_CONFIG,
      "push",
      "-u",
      "origin",
      input.branch,
    ],
    authOptions(input.token),
  );
}
