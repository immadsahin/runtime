import {
  ModalClient,
  NotFoundError,
  type Sandbox,
  type Secret,
  type Volume,
} from "modal";

import { optionalEnv, requireEnv } from "@/lib/env";
import { agentCommand } from "@/lib/runtime/agent";
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

export const MODAL_IMAGE_COMMANDS = [
  "RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git && rm -rf /var/lib/apt/lists/*",
  "RUN npm install -g @anthropic-ai/claude-code @openai/codex",
] as const;

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

  /** GitExec capability for the shared git module: run argv in a sandbox.
   * Git commands carry their own `-C`, so no workdir is needed; the auth token
   * (when present) rides in the process environment. */
  private gitExec(sandbox: Sandbox): GitExec {
    return async (argv, options) => {
      const process = await sandbox.exec(argv, { env: options?.env });
      const [stdout, stderr, exitCode] = await Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
        process.wait(),
      ]);
      return { stdout, stderr, exitCode };
    };
  }

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
      const git = this.gitExec(sandbox);

      await input.onPhase?.("clone");
      const repoPath = `${WORKSPACE_ROOT}/repo`;
      await cloneRepo(git, {
        repoFullName: input.repoFullName,
        dir: repoPath,
        token: input.env.GITHUB_PAT,
      });

      await input.onPhase?.("worktree");
      await run(sandbox, ["mkdir", "-p", `${WORKSPACE_ROOT}/worktrees`]);
      await addWorktree(git, {
        repoDir: repoPath,
        worktreePath,
        branch: input.branch,
        baseRef: `origin/${input.baseBranch}`,
      });

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
      await run(sandbox, ["git", "status", "--short"], {
        workdir: worktreePath,
      });

      await input.onPhase?.("claude_ready");
      await run(sandbox, ["claude", "--version"]);
      await run(sandbox, ["codex", "--version"]);

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
          console.error(
            "Could not terminate failed Modal workspace",
            terminationError,
          );
        });
      }
      if (volumeAllocated) {
        await this.client.volumes
          .delete(volumeName, { allowMissing: true })
          .catch((deletionError: unknown) => {
            console.error(
              "Could not delete failed Modal workspace volume",
              deletionError,
            );
          });
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
      [
        "bash",
        "-lc",
        modalDetachedJobScript(
          agentCommand(input.agent, input),
          logPath,
          resultPath,
        ),
      ],
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
        const output = await run(sandbox, [
          "bash",
          "-lc",
          `wc -c < ${shellQuote(expected)}`,
        ]);
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
    const worktree = await this.worktreePath(sandbox);
    return gitListChangedFiles(this.gitExec(sandbox), { worktree });
  }

  async readChangedFileDiff(input: {
    workspaceId: string;
    sandboxId: string;
    path: string;
  }): Promise<string> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const worktree = await this.worktreePath(sandbox);
    return readFileDiff(this.gitExec(sandbox), { worktree, path: input.path });
  }

  async commitWorkspace(
    input: CommitWorkspaceInput,
  ): Promise<CommitWorkspaceResult> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const worktree = await this.worktreePath(sandbox);
    return commitAll(this.gitExec(sandbox), {
      worktree,
      message: input.message,
      author: input.author,
    });
  }

  async pushWorkspaceBranch(input: PushWorkspaceBranchInput): Promise<void> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    const worktree = await this.worktreePath(sandbox);
    await pushBranch(this.gitExec(sandbox), {
      worktree,
      repoFullName: input.repoFullName,
      branch: input.branch,
      token: input.githubToken,
    });
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
    throw new Error(
      "Pull requests are created through Runtime's GitHub API path.",
    );
  }

  /** The single worktree directory under the Volume, located at call time. */
  private async worktreePath(sandbox: Sandbox): Promise<string> {
    const out = await run(sandbox, [
      "bash",
      "-lc",
      "find /runtime/worktrees -mindepth 1 -maxdepth 1 -type d -print -quit",
    ]);
    const worktree = out.trim();
    if (!worktree) throw new Error("No worktree found for workspace");
    return worktree;
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
      .dockerfileCommands([...MODAL_IMAGE_COMMANDS]);
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

  private async secretFor(
    env: Record<string, string>,
  ): Promise<Secret | undefined> {
    return Object.keys(env).length
      ? this.client.secrets.fromObject(env)
      : undefined;
  }
}

function workspaceVolumeName(workspaceId: string): string {
  return `runtime-workspace-${workspaceId}`;
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

function modalDetachedJobScript(
  command: string,
  logPath: string,
  resultPath: string,
): string {
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

function isJobResult(value: unknown): value is JobResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    (result.status === "succeeded" ||
      result.status === "failed" ||
      result.status === "cancelled") &&
    (typeof result.exitCode === "number" || result.exitCode === null) &&
    typeof result.finishedAt === "string"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
