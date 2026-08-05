import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addWorktree,
  cloneRepo,
  commitAll,
  listChangedFiles as gitListChangedFiles,
  pushBranch,
  readFileDiff,
  sanitizeBranch,
  type GitExec,
} from "@/lib/runtime/git";
import type {
  ChangedFile,
  CommitWorkspaceInput,
  CommitWorkspaceResult,
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateWorkspaceInput,
  CreateWorkspaceResult,
  PushWorkspaceBranchInput,
  RuntimeProvider,
} from "@/lib/runtime/types";

const ROOT =
  process.env.RUNTIME_LOCAL_ROOT ?? path.join(os.tmpdir(), "runtime-local");
const SAFE_CHILD_ENV_KEYS = [
  "CI",
  "COREPACK_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NPM_CONFIG_CACHE",
  "PATH",
  "PNPM_HOME",
  "SHELL",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const;

/**
 * Development backend: same lifecycle as Modal, executed on this machine.
 *
 * Layout mirrors the sandbox layout exactly, so paths in the UI are identical
 * across providers:
 *
 *   <ROOT>/<workspaceId>/repo          bare-ish clone (source of truth)
 *   <ROOT>/<workspaceId>/worktrees/<b> git worktree the agent edits
 *   <ROOT>/<workspaceId>/.runtime/logs/<jobId>.log
 */
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly name = "local" as const;

  /** GitExec capability for the shared git module: a plain child process on
   * this host with a scrubbed environment. Git commands carry their own `-C`,
   * so no cwd is needed. */
  private readonly git: GitExec = (argv, options) =>
    new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        env: { ...safeChildEnvironment(), ...(options?.env ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) =>
        resolve({ stdout, stderr: stderr || String(e), exitCode: 1 }),
      );
      child.on("close", (code) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 }),
      );
    });

  private paths(workspaceId: string) {
    const base = path.join(ROOT, workspaceId);
    return {
      base,
      repo: path.join(base, "repo"),
      worktrees: path.join(base, "worktrees"),
      provisionWarnings: path.join(base, ".runtime", "provision-warnings.log"),
    };
  }

  async createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<CreateWorkspaceResult> {
    const p = this.paths(input.workspaceId);

    await input.onPhase?.("allocate");
    await fs.mkdir(p.worktrees, { recursive: true });
    await fs.mkdir(path.dirname(p.provisionWarnings), { recursive: true });

    await input.onPhase?.("clone");
    if (!(await exists(p.repo))) {
      await cloneRepo(this.git, {
        repoFullName: input.repoFullName,
        dir: p.repo,
        token: input.env.GITHUB_PAT,
      });
    }

    await input.onPhase?.("worktree");
    const worktreePath = path.join(p.worktrees, sanitizeBranch(input.branch));
    if (!(await exists(worktreePath))) {
      await addWorktree(this.git, {
        repoDir: p.repo,
        worktreePath,
        branch: input.branch,
        baseRef: `origin/${input.baseBranch}`,
      });
    }

    await input.onPhase?.("secrets");
    // Dependency lifecycle scripts belong to the repository being cloned, so
    // never expose Runtime credentials until an explicit Claude job starts.

    await input.onPhase?.("install");
    const warnings: string[] = [];
    const install = input.installCommand ?? (await inferInstall(worktreePath));
    if (install) {
      try {
        await run("bash", ["-lc", install], { cwd: worktreePath });
      } catch (error) {
        // Dependency setup is advisory: a repository may be intentionally
        // incomplete until the operator supplies a secret. Return and persist
        // the warning so callers can surface it before an agent job starts.
        const warning = `Dependency installation failed: ${errorMessage(error)}`;
        warnings.push(warning);
        await fs.appendFile(p.provisionWarnings, `${warning}\n`, {
          mode: 0o600,
        });
        console.warn(`Runtime workspace ${input.workspaceId}: ${warning}`);
      }
    }

    await input.onPhase?.("health_check");
    await run("git", ["status", "--short"], { cwd: worktreePath });
    await run("claude", ["--version"], { cwd: worktreePath });
    await run("codex", ["--version"], { cwd: worktreePath });

    await input.onPhase?.("claude_ready");
    return {
      sandboxId: `local:${input.workspaceId}`,
      volumeName: `local:${input.workspaceId}`,
      worktreePath,
      warnings,
    };
  }

  async resumeWorkspace(input: {
    workspaceId: string;
  }): Promise<{ sandboxId: string }> {
    return { sandboxId: `local:${input.workspaceId}` };
  }

  async sandboxAlive(sandboxId: string): Promise<boolean> {
    // The "sandbox" is just this host, so its handle never expires.
    return sandboxId.length > 0;
  }

  async suspendWorkspace(): Promise<void> {
    // No compute to release locally.
  }

  async destroyWorkspace(input: { workspaceId: string }): Promise<void> {
    await fs.rm(this.paths(input.workspaceId).base, {
      recursive: true,
      force: true,
    });
  }

  async listChangedFiles(input: {
    workspaceId: string;
  }): Promise<ChangedFile[]> {
    const worktree = await this.requireWorktree(input.workspaceId);
    return gitListChangedFiles(this.git, { worktree });
  }

  async readChangedFileDiff(input: {
    workspaceId: string;
    path: string;
  }): Promise<string> {
    const worktree = await this.requireWorktree(input.workspaceId);
    return readFileDiff(this.git, { worktree, path: input.path });
  }

  async commitWorkspace(
    input: CommitWorkspaceInput,
  ): Promise<CommitWorkspaceResult> {
    const worktree = await this.requireWorktree(input.workspaceId);
    return commitAll(this.git, {
      worktree,
      message: input.message,
      author: input.author,
    });
  }

  async pushWorkspaceBranch(input: PushWorkspaceBranchInput): Promise<void> {
    const worktree = await this.requireWorktree(input.workspaceId);
    await pushBranch(this.git, {
      worktree,
      repoFullName: input.repoFullName,
      branch: input.branch,
      token: input.githubToken,
    });
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    void input;
    throw new Error(
      "Pull requests are created through Runtime's GitHub API path.",
    );
  }

  private async requireWorktree(workspaceId: string): Promise<string> {
    const worktree = await firstWorktree(this.paths(workspaceId).worktrees);
    if (!worktree) throw new Error("No worktree found for workspace");
    return worktree;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function inferInstall(dir: string): Promise<string | null> {
  if (await exists(path.join(dir, "pnpm-lock.yaml"))) {
    return "pnpm install --frozen-lockfile";
  }
  if (await exists(path.join(dir, "package-lock.json"))) return "npm ci";
  if (await exists(path.join(dir, "yarn.lock"))) {
    return (await exists(path.join(dir, ".yarnrc.yml")))
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile";
  }
  if (await exists(path.join(dir, "package.json"))) return "npm install";
  if (await exists(path.join(dir, "uv.lock"))) return "uv sync";
  if (await exists(path.join(dir, "requirements.txt"))) {
    return "pip install -r requirements.txt";
  }
  if (await exists(path.join(dir, "Cargo.toml"))) return "cargo fetch";
  if (await exists(path.join(dir, "go.mod"))) return "go mod download";
  return null;
}

async function firstWorktree(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const name = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))[0];
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? safeChildEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`)),
    );
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function safeChildEnvironment(
  additions?: Record<string, string>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return additions ? Object.assign(environment, additions) : environment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
