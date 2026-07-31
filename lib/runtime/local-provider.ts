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

const ROOT =
  process.env.RUNTIME_LOCAL_ROOT ?? path.join(os.tmpdir(), "runtime-local");

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
    const remote = token
      ? `https://x-access-token:${token}@github.com/${input.repoFullName}.git`
      : `https://github.com/${input.repoFullName}.git`;
    if (!(await exists(p.repo))) {
      await run("git", ["clone", remote, p.repo], { cwd: p.base });
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
    await fs.mkdir(path.dirname(p.env), { recursive: true });
    await fs.writeFile(
      p.env,
      Object.entries(input.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      { mode: 0o600 },
    );

    await input.onPhase?.("install");
    const install = input.installCommand ?? (await inferInstall(worktreePath));
    if (install) {
      await run("bash", ["-lc", install], { cwd: worktreePath }).catch(() => {
        // A failing install must not fail the whole workspace; it is surfaced
        // as a health-check warning instead.
      });
    }

    await input.onPhase?.("health_check");
    await run("git", ["status", "--short"], { cwd: worktreePath });

    await input.onPhase?.("claude_ready");
    return {
      sandboxId: `local:${input.workspaceId}`,
      volumeName: `local:${input.workspaceId}`,
      worktreePath,
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

    const worktree = await firstWorktree(p.worktrees);

    // Detached: the job outlives this HTTP request, exactly like Modal.
    const child = spawn(
      "bash",
      ["-lc", claudeCommand(input) + ` >> ${shellQuote(logPath)} 2>&1`],
      { cwd: worktree ?? p.base, detached: true, stdio: "ignore" },
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
  if (await exists(path.join(dir, "yarn.lock"))) return "yarn install";
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
    const entries = await fs.readdir(dir);
    return entries[0] ? path.join(dir, entries[0]) : null;
  } catch {
    return null;
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
