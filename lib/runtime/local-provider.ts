import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateWorkspaceInput,
  CreateWorkspaceResult,
  ExecuteJobInput,
  ExecuteJobResult,
  LogChunk,
  RuntimeProvider,
  StreamLogsInput,
} from "@/lib/runtime/types";
import { workspaceRuntimeEnvironment } from "@/lib/runtime/workspace-environment";

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

  private paths(workspaceId: string) {
    const base = path.join(ROOT, workspaceId);
    return {
      base,
      repo: path.join(base, "repo"),
      worktrees: path.join(base, "worktrees"),
      logs: path.join(base, ".runtime", "logs"),
      env: path.join(base, ".runtime", "env"),
      provisionWarnings: path.join(base, ".runtime", "provision-warnings.log"),
    };
  }

  async createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<CreateWorkspaceResult> {
    const p = this.paths(input.workspaceId);

    await input.onPhase?.("allocate");
    await fs.mkdir(p.worktrees, { recursive: true });
    await fs.mkdir(p.logs, { recursive: true });

    await input.onPhase?.("clone");
    const token = input.env.GITHUB_PAT;
    const remote = `https://github.com/${input.repoFullName}.git`;
    if (!(await exists(p.repo))) {
      const gitAuth = token ? await createGitAskPass(p.base, token) : null;
      try {
        await run("git", ["clone", remote, p.repo], {
          cwd: p.base,
          env: gitAuth?.env,
        });
      } finally {
        await gitAuth?.remove();
      }
      // Never persist the token in git config.
      await run(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          `https://github.com/${input.repoFullName}.git`,
        ],
        { cwd: p.repo },
      );
    }

    await input.onPhase?.("worktree");
    const worktreePath = path.join(p.worktrees, sanitizeBranch(input.branch));
    if (!(await exists(worktreePath))) {
      await run(
        "git",
        [
          "worktree",
          "add",
          "-b",
          input.branch,
          worktreePath,
          `origin/${input.baseBranch}`,
        ],
        { cwd: p.repo },
      );
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

  async executeJob(input: ExecuteJobInput): Promise<ExecuteJobResult> {
    const p = this.paths(input.workspaceId);
    await fs.mkdir(p.logs, { recursive: true });
    const logPath = path.join(p.logs, `${input.jobId}.log`);
    await fs.writeFile(logPath, "");
    const workspaceEnv = workspaceRuntimeEnvironment();
    if (Object.keys(workspaceEnv).length > 0) {
      await fs.mkdir(path.dirname(p.env), { recursive: true });
      await writeEnvironmentFile(p.env, workspaceEnv);
    }

    const worktree = await firstWorktree(p.worktrees);

    // Detached: the job outlives this HTTP request, exactly like Modal.
    const child = spawn(
      "bash",
      [
        "-lc",
        `${sourceEnvironmentCommand(p.env, true)} ${claudeCommand(input)} >> ${shellQuote(logPath)} 2>&1`,
      ],
      {
        cwd: worktree ?? p.base,
        detached: true,
        env: safeChildEnvironment(),
        stdio: "ignore",
      },
    );
    child.unref();

    return { logPath };
  }

  async *streamLogs(input: StreamLogsInput): AsyncIterable<LogChunk> {
    let offset = input.fromOffset ?? 0;

    while (!input.signal?.aborted) {
      let size = 0;
      try {
        size = (await fs.stat(input.logPath)).size;
      } catch {
        await sleep(500);
        continue;
      }

      if (size > offset) {
        const chunk = await readRange(input.logPath, offset, size - 1);
        offset = size;
        yield { offset, text: chunk };
      }
      await sleep(400);
    }
  }

  async suspendWorkspace(): Promise<void> {
    // No compute to release locally.
  }

  async destroyWorkspace(input: {
    workspaceId: string;
  }): Promise<void> {
    await fs.rm(this.paths(input.workspaceId).base, {
      recursive: true,
      force: true,
    });
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    const p = this.paths(input.workspaceId);
    const worktree = await firstWorktree(p.worktrees);
    if (!worktree) throw new Error("No worktree found for workspace");

    await run("git", ["push", "-u", "origin", input.branch], { cwd: worktree });
    const out = await run(
      "gh",
      [
        "pr",
        "create",
        "--title",
        input.title,
        "--body",
        input.body,
        "--base",
        input.baseBranch,
        "--head",
        input.branch,
      ],
      { cwd: worktree },
    );

    const url = out.trim().split("\n").at(-1) ?? "";
    const number = Number(url.split("/").at(-1) ?? 0);
    return { url, number };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Headless Claude Code invocation.
 *
 * Flags are pinned deliberately: `--permission-mode` because v2.1.200 changed
 * the default to Manual (which hangs unattended), and `stream-json` so the UI
 * can render structured events rather than scraped text.
 */
function claudeCommand(input: ExecuteJobInput): string {
  const args = [
    "claude",
    "-p",
    shellQuote(input.prompt),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    shellQuote("Read,Edit,Write,Bash,Glob,Grep"),
  ];
  if (input.resumeSessionId) {
    args.push("--resume", shellQuote(input.resumeSessionId));
  }
  return args.join(" ");
}

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

function readRange(file: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const stream = createReadStream(file, { start, end, encoding: "utf8" });
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
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

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sourceEnvironmentCommand(file: string, removeAfterLoad = false): string {
  const quoted = shellQuote(file);
  return `if [ -f ${quoted} ]; then set -a; . ${quoted}; ${removeAfterLoad ? `rm -f ${quoted}; ` : ""}set +a; fi;`;
}

async function writeEnvironmentFile(
  file: string,
  env: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  for (const [key] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }
  await fs.writeFile(
    file,
    entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n"),
    { mode: 0o600 },
  );
}

async function createGitAskPass(base: string, token: string) {
  const file = path.join(base, ".runtime", "git-askpass.sh");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s' x-access-token ;;\n  *) printf '%s' \"$RUNTIME_GIT_PASSWORD\" ;;\nesac\n",
    { mode: 0o700 },
  );

  return {
    env: {
      ...safeChildEnvironment(),
      GIT_ASKPASS: file,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
      RUNTIME_GIT_PASSWORD: token,
    },
    remove: () => fs.rm(file, { force: true }),
  };
}

function safeChildEnvironment(additions?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
