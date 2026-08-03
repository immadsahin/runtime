import { ModalClient, type Sandbox, type Volume } from "modal";

import { optionalEnv, requireEnv } from "@/lib/env";
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

    try {
      await input.onPhase?.("allocate");
      const volume = await this.client.volumes.fromName(volumeName, {
        createIfMissing: true,
      });
      sandbox = await this.createSandbox(input.workspaceId, volume, input.env);

      await input.onPhase?.("clone");
      const repoPath = `${WORKSPACE_ROOT}/repo`;
      await run(sandbox, ["bash", "-lc", cloneScript(input.repoFullName, repoPath)]);

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
      throw error;
    }
  }

  async resumeWorkspace(input: {
    workspaceId: string;
    volumeName: string;
    env: Record<string, string>;
  }): Promise<{ sandboxId: string }> {
    const volume = await this.client.volumes.fromName(input.volumeName);
    const sandbox = await this.createSandbox(input.workspaceId, volume, input.env);
    const sandboxId = sandbox.sandboxId;
    sandbox.detach();
    return { sandboxId };
  }

  async executeJob(input: ExecuteJobInput): Promise<ExecuteJobResult> {
    void input;
    throw new Error("Modal job execution arrives in milestone M6.");
  }

  async *streamLogs(input: StreamLogsInput): AsyncIterable<LogChunk> {
    void input;
    throw new Error("Modal log streaming arrives in milestone M7.");
  }

  async suspendWorkspace(input: {
    workspaceId: string;
    sandboxId: string;
  }): Promise<void> {
    const sandbox = await this.client.sandboxes.fromId(input.sandboxId);
    await sandbox.terminate();
  }

  async destroyWorkspace(input: {
    workspaceId: string;
    sandboxId: string | null;
    volumeName: string | null;
  }): Promise<void> {
    if (input.sandboxId) {
      await this.client.sandboxes
        .fromId(input.sandboxId)
        .then((sandbox) => sandbox.terminate())
        .catch((error: unknown) => {
          // A 24-hour sandbox may already be gone; the durable Volume still
          // must be removed below.
          console.warn(`Could not terminate Modal sandbox ${input.sandboxId}`, error);
        });
    }
    if (input.volumeName) {
      await this.client.volumes.delete(input.volumeName, { allowMissing: true });
    }
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    void input;
    throw new Error("Modal pull-request creation arrives in milestone M9.");
  }

  private async createSandbox(
    workspaceId: string,
    volume: Volume,
    env: Record<string, string>,
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
    const secret = Object.keys(env).length
      ? await this.client.secrets.fromObject(env)
      : undefined;

    return this.client.sandboxes.create(app, image, {
      command: ["sleep", "86400"],
      cpu: 2,
      memoryMiB: 4096,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      workdir: WORKSPACE_ROOT,
      volumes: { [WORKSPACE_ROOT]: volume },
      ...(secret ? { secrets: [secret] } : {}),
      name: `runtime-${workspaceId}`,
      tags: { "runtime.workspace_id": workspaceId },
    });
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
  options?: { workdir?: string },
): Promise<void> {
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
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
