import { ModalClient, NotFoundError, type Sandbox, type Secret, type Volume } from "modal";

import { optionalEnv, requireEnv } from "@/lib/env";
import type {
  ChangedFile,
  CommitWorkspaceInput,
  CommitWorkspaceResult,
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateWorkspaceInput,
  CreateWorkspaceResult,
  ExecuteJobInput,
  ExecuteJobResult,
  JobPaths,
  JobResult,
  LogChunk,
  PushWorkspaceBranchInput,
  RuntimeProvider,
  StreamLogsInput,
} from "@/lib/runtime/types";

const WORKSPACE_ROOT = "/runtime";
const SANDBOX_TIMEOUT_MS = 86_400_000;

/**
 * Production backend for Runtime workspaces.
 *
 * Each workspace gets a named Modal Volume mounted at `/runtime`. The sandbox
 * is disposable (Modal hard-limits a sandbox to 24 hours), while the volume is
 * durable and becomes the source of truth for the clone, worktree, logs, and
 * any future Claude Code session state.
 */
export class ModalRuntimeProvider implements RuntimeProvider {
  readonly name = "modal" as const;

  private readonly client = new ModalClient({
    tokenId: requireEnv("MODAL_TOKEN_ID"),
    tokenSecret: requireEnv("MODAL_TOKEN_SECRET"),
  });

  private readonly appName = optionalEnv("MODAL_APP_NAME") ?? "runtime";

  async createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<CreateWorkspaceResult> {
    const volumeName = workspaceVolumeName(input.workspaceId);
    const worktreePath = `${WORKSPACE_ROOT}/worktrees/${sanitizeBranch(input.branch)}`;
    let sandbox: Sandbox | null = null;
    let volumeAllocated = false;

    try {
      await input.onPhase?.("allocate");
      const volume = await this.client.volumes.fromName(volumeName, {
        createIfMissing: true,
      });
      volumeAllocated = true;
      sandbox = await this.createSandbox(input.workspaceId, volume);

      await input.onPhase?.("clone");
      const repoPath = `${WORKSPACE_ROOT}/repo`;
      await this.cloneRepository(sandbox, input.repoFullName, repoPath, input.env.GITHUB_PAT);

      await input.onPhase?.("worktree");
      await run(sandbox, ["mkdir", "-p", `${WORKSPACE_ROOT}/worktrees`]);
      await run(sandbox, [
        "git",
        "-C",
        repoPath,
        "worktree",
        "add",
        "-b",
        input.branch,
        worktreePath,
        `origin/${input.baseBranch}`,
      ]);

      // The short-lived Modal Secret is injected only for this sandbox; no
      // token is written into the Volume or Git remote configuration.
      await input.onPhase?.("secrets");

      await input.onPhase?.("install");
      const warnings: string[] = [];
      const install = input.installCommand ?? defaultInstallCommand();
      try {
        await run(sandbox, ["bash", "-lc", install], { workdir: worktreePath });
      } catch (error) {
        const warning =
          "Dependency installation failed; inspect the workspace before running a job.";
        warnings.push(warning);
        console.warn(`Runtime Modal workspace ${input.workspaceId}:`, error);
      }

      await input.onPhase?.("health_check");
      await run(sandbox, ["git", "status", "--short"], { workdir: worktreePath });

      await input.onPhase?.("claude_ready");
      await run(sandbox, ["claude", "--version"]);

      const result = {
        sandboxId: sandbox.sandboxId,
        volumeName,
        worktreePath,
        warnings,
      };
      // Disconnect this web request from the sandbox without stopping it. The
      // persisted sandbox ID and Volume are used by M5 to resume after expiry.
      sandbox.detach();
      return result;
    } catch (error) {
      if (sandbox) {
        await sandbox.terminate().catch((terminationError: unknown) => {
          console.error("Could not terminate failed Modal workspace", terminationError);
        });
      }
      if (volumeAllocated) {
        await this.client.volumes.delete(volumeName, { allowMissing: true }).catch(
          (deletionError: unknown) => {
            console.error("Could not delete failed Modal workspace volume", deletionError);
          },
        );
      }
      throw error;
    }
  }

  async resumeWorkspace(input: {
    workspaceId: string;
    volumeName: string;
    env: Record<string, string>;
  }): Promise<{ sandboxId: string }> {
    const volume = await this.client.volumes.fromName(input.volumeName);
    const sandbox = await this.createSandbox(input.workspaceId, volume);
    const sandboxId = sandbox.sandboxId;
    sandbox.detach();
    return { sandboxId };
  }

  async sandboxAlive(sandboxId: string): Promise<boolean> {
    if (!sandboxId) return false;
    try {
      const sandbox = await this.client.sandboxes.fromId(sandboxId);
      // poll() resolves to the exit code, or null while the sandbox is running.
      return (await sandbox.poll()) === null;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      console.error(`Could not poll Modal sandbox ${sandboxId}`, error);
      return false;
    }
  }

  async executeJob(input: ExecuteJobInput): Promise<ExecuteJobResult> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const { logPath, resultPath } = this.getJobPaths(input);
    const secret = await this.secretFor(input.env);
    await run(
      sandbox,
      ["bash", "-lc", modalDetachedJobScript(claudeCommand(input), logPath, resultPath)],
      { secrets: secret ? [secret] : undefined },
    );
    sandbox.detach();
    return { logPath, resultPath, executionHandle: input.sandboxId };
  }

  getJobPaths(input: { workspaceId: string; jobId: string }): JobPaths {
    void input.workspaceId;
    return {
      logPath: `${WORKSPACE_ROOT}/.runtime/logs/${input.jobId}.log`,
      resultPath: `${WORKSPACE_ROOT}/.runtime/logs/${input.jobId}.result.json`,
    };
  }

  async getJobResult(input: {
    workspaceId: string;
    sandboxId: string;
    jobId: string;
    resultPath: string;
  }): Promise<JobResult | null> {
    const expected = `${WORKSPACE_ROOT}/.runtime/logs/${input.jobId}.result.json`;
    if (input.resultPath !== expected) throw new Error("Invalid job result path");
    try {
      const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
      const output = await run(sandbox, ["cat", expected]);
      const parsed = JSON.parse(output) as unknown;
      return isJobResult(parsed) ? parsed : null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      return null;
    }
  }

  async *streamLogs(input: StreamLogsInput): AsyncIterable<LogChunk> {
    const expected = `${WORKSPACE_ROOT}/.runtime/logs/${input.jobId}.log`;
    if (input.logPath !== expected) throw new Error("Invalid job log path");
    let offset = input.fromOffset ?? 0;
    while (!input.signal?.aborted) {
      try {
        const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
        const output = await run(sandbox, ["bash", "-lc", `wc -c < ${shellQuote(expected)}`]);
        const size = Number(output.trim());
        if (Number.isFinite(size) && size > offset) {
          const chunk = await run(sandbox, [
            "bash",
            "-lc",
            `tail -c +${offset + 1} ${shellQuote(expected)} | head -c 65536`,
          ]);
          offset += Buffer.byteLength(chunk, "utf8");
          yield { offset, text: chunk };
        }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      await sleep(500);
    }
  }

  async listChangedFiles(input: {
    workspaceId: string;
    sandboxId: string;
  }): Promise<ChangedFile[]> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const output = await run(sandbox, ["bash", "-lc", `git -C ${modalWorktree()} status --porcelain=v1 -z --untracked-files=all`]);
    return parseChangedFiles(output);
  }

  async readChangedFileDiff(input: {
    workspaceId: string;
    sandboxId: string;
    path: string;
  }): Promise<string> {
    if (!isSafeRelativePath(input.path)) {
      throw new Error("Invalid changed file path");
    }
    const changes = await this.listChangedFiles(input);
    const file = changes.find((change) => change.path === input.path);
    if (!file) throw new Error("File is not part of this workspace change set");
    if (file.status === "untracked") return "This untracked file has no Git diff yet.";
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const diff = await run(sandbox, [
      "bash",
      "-lc",
      `git --literal-pathspecs -C ${modalWorktree()} diff --no-ext-diff --no-textconv -- ${shellQuote(input.path)} | head -c 200000`,
    ]);
    return diff;
  }

  async commitWorkspace(input: CommitWorkspaceInput): Promise<CommitWorkspaceResult> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const env = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    };
    await run(sandbox, ["bash", "-lc", `git -C ${modalWorktree()} add -A && git -C ${modalWorktree()} commit -m ${shellQuote(input.message)}`], { env });
    const sha = (await run(sandbox, ["bash", "-lc", `git -C ${modalWorktree()} rev-parse HEAD`])).trim();
    return { sha };
  }

  async pushWorkspaceBranch(input: PushWorkspaceBranchInput): Promise<void> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const remote = `https://github.com/${input.repoFullName}.git`;
    const secret = await this.secretFor({ GITHUB_PAT: input.githubToken });
    await run(
      sandbox,
      ["bash", "-lc", pushScript(modalWorktree(), remote, input.branch)],
      { secrets: secret ? [secret] : undefined },
    );
  }

  async suspendWorkspace(input: {
    workspaceId: string;
    sandboxId: string;
  }): Promise<void> {
    try {
      const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
      await sandbox.terminate();
    } catch (error) {
      // Modal Sandboxes are intentionally disposable and expire at 24 hours.
      // An absent sandbox is already suspended from Runtime's perspective.
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  async destroyWorkspace(input: {
    workspaceId: string;
    sandboxId: string | null;
    volumeName: string | null;
  }): Promise<void> {
    if (input.sandboxId) {
      try {
        const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
        await sandbox.terminate();
      } catch (error) {
        // A 24-hour sandbox may already be gone; it has no compute to clean.
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    if (input.volumeName) {
      await this.client.volumes.delete(input.volumeName, { allowMissing: true });
    }
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    void input;
    throw new Error("Pull requests are created through Runtime's GitHub API path.");
  }

  private async createSandbox(
    workspaceId: string,
    volume: Volume,
  ): Promise<Sandbox> {
    const app = await this.client.apps.fromName(this.appName, {
      createIfMissing: true,
    });
    const image = this.client.images
      .fromRegistry("node:22-bookworm")
      .dockerfileCommands([
        "RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git && rm -rf /var/lib/apt/lists/*",
        "RUN npm install -g @anthropic-ai/claude-code",
      ]);
    return this.client.sandboxes.create(app, image, {
      command: ["sleep", "86400"],
      cpu: 2,
      memoryMiB: 4096,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      workdir: WORKSPACE_ROOT,
      volumes: { [WORKSPACE_ROOT]: volume },
      name: `runtime-${workspaceId}`,
      tags: { "runtime.workspace_id": workspaceId },
    });
  }

  private async cloneRepository(
    sandbox: Sandbox,
    repoFullName: string,
    repoPath: string,
    githubToken?: string,
  ): Promise<void> {
    const secret = githubToken ? await this.secretFor({ GITHUB_PAT: githubToken }) : undefined;
    await run(sandbox, ["bash", "-lc", cloneScript(repoFullName, repoPath)], {
      secrets: secret ? [secret] : undefined,
    });
  }

  private async secretFor(env: Record<string, string>): Promise<Secret | undefined> {
    return Object.keys(env).length ? this.client.secrets.fromObject(env) : undefined;
  }
}

function workspaceVolumeName(workspaceId: string): string {
  return `runtime-workspace-${workspaceId}`;
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function cloneScript(repoFullName: string, repoPath: string): string {
  const remote = `https://github.com/${repoFullName}.git`;
  return [
    "set -euo pipefail",
    `if [ -d ${shellQuote(`${repoPath}/.git`)} ]; then exit 0; fi`,
    "mkdir -p /tmp/runtime-git-askpass",
    "cat > /tmp/runtime-git-askpass/askpass <<'EOF'",
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) printf '%s' x-access-token ;;",
    "  *) printf '%s' \"${GITHUB_PAT:-}\" ;;",
    "esac",
    "EOF",
    "chmod 700 /tmp/runtime-git-askpass/askpass",
    "if [ -n \"${GITHUB_PAT:-}\" ]; then",
    `  GIT_ASKPASS=/tmp/runtime-git-askpass/askpass GIT_ASKPASS_REQUIRE=force GIT_TERMINAL_PROMPT=0 git clone ${shellQuote(remote)} ${shellQuote(repoPath)}`,
    "else",
    `  git clone ${shellQuote(remote)} ${shellQuote(repoPath)}`,
    "fi",
    `git -C ${shellQuote(repoPath)} remote set-url origin ${shellQuote(remote)}`,
    "rm -rf /tmp/runtime-git-askpass",
  ].join("\n");
}

function defaultInstallCommand(): string {
  return [
    "set -e",
    "if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; exit 0; fi",
    "if [ -f package-lock.json ]; then npm ci; exit 0; fi",
    "if [ -f yarn.lock ]; then yarn install --frozen-lockfile; exit 0; fi",
    "if [ -f uv.lock ]; then uv sync; exit 0; fi",
    "if [ -f requirements.txt ]; then pip install -r requirements.txt; exit 0; fi",
    "if [ -f Cargo.toml ]; then cargo fetch; exit 0; fi",
    "if [ -f go.mod ]; then go mod download; exit 0; fi",
  ].join("\n");
}

async function run(
  sandbox: Sandbox,
  command: string[],
  options?: { workdir?: string; env?: Record<string, string>; secrets?: Secret[] },
): Promise<string> {
  const process = await sandbox.exec(command, options);
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout.readText(),
    process.stderr.readText(),
    process.wait(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Modal command failed (${command[0]}): ${stderr || stdout || `exit ${exitCode}`}`,
    );
  }
  return stdout;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function modalWorktree(): string {
  return '"$(find /runtime/worktrees -mindepth 1 -maxdepth 1 -type d -print -quit)"';
}

function claudeCommand(input: ExecuteJobInput): string {
  const args = [
    "claude",
    "-p",
    shellQuote(input.prompt),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    shellQuote("Read,Edit,Write,Bash,Glob,Grep"),
  ];
  if (input.resumeSessionId) args.push("--resume", shellQuote(input.resumeSessionId));
  return args.join(" ");
}

function modalDetachedJobScript(command: string, logPath: string, resultPath: string): string {
  const log = shellQuote(logPath);
  const result = shellQuote(resultPath);
  const runner = [
    "umask 077",
    "set +e",
    `${command} >> ${log} 2>&1`,
    "exit_code=$?",
    'if [ "$exit_code" -eq 0 ]; then result_status=succeeded; else result_status=failed; fi',
    `printf '{"status":"%s","exitCode":%s,"finishedAt":"%s"}\\n' "$result_status" "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${result}`,
  ].join("; ");
  return `mkdir -p ${shellQuote(`${WORKSPACE_ROOT}/.runtime/logs`)}; nohup bash -lc ${shellQuote(runner)} >/dev/null 2>&1 &`;
}

function pushScript(worktree: string, remote: string, branch: string): string {
  const askpass = "/tmp/runtime-git-askpass";
  return [
    "set -euo pipefail",
    `git -C ${worktree} remote set-url origin ${shellQuote(remote)}`,
    `cat > ${askpass} <<'EOF'`,
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) printf '%s' x-access-token ;;",
    "  *) printf '%s' \"${GITHUB_PAT:-}\" ;;",
    "esac",
    "EOF",
    `chmod 700 ${askpass}`,
    `GIT_ASKPASS=${askpass} GIT_ASKPASS_REQUIRE=force GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null -c credential.helper= -C ${worktree} push -u origin ${shellQuote(branch)}`,
    `rm -f ${askpass}`,
    `git -C ${worktree} remote set-url origin ${shellQuote(remote)}`,
  ].join("\n");
}

function parseChangedFiles(output: string): ChangedFile[] {
  const entries = output.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    if (code.includes("R") || code.includes("C")) index += 1;
    files.push({
      path: filePath,
      status:
        code === "??" ? "untracked" :
        code.includes("A") ? "added" :
        code.includes("D") ? "deleted" :
        code.includes("R") || code.includes("C") ? "renamed" : "modified",
      additions: 0,
      deletions: 0,
    });
  }
  return files.slice(0, 500);
}

function isJobResult(value: unknown): value is JobResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    (result.status === "succeeded" || result.status === "failed" || result.status === "cancelled") &&
    (typeof result.exitCode === "number" || result.exitCode === null) &&
    typeof result.finishedAt === "string"
  );
}

/** Preserve one provider-owned changed path; reject traversal and Git magic. */
function isSafeRelativePath(filePath: string): boolean {
  return (
    Boolean(filePath) &&
    !filePath.includes("\0") &&
    !filePath.startsWith("/") &&
    !filePath.startsWith(":") &&
    filePath.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
