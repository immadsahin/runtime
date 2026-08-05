import { readFile } from "node:fs/promises";
import path from "node:path";

import { Daytona, type Sandbox } from "@daytonaio/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import type { AgentTarget } from "@/lib/runtime/agent-client";
import {
  AGENT_PORT,
  bootAgent,
  type BoxIO,
  ProvisionTimer,
  shellQuote,
  uploadAgent,
  waitForAgentHealth,
} from "@/lib/runtime/daytona/deploy";
import { cloneMirror, fetchMirror, type GitExec } from "@/lib/runtime/git";
import type {
  ChangedFile,
  CommitWorkspaceResult,
  CreatePullRequestResult,
  CreateWorkspaceResult,
  ProvisionStage,
  ProvisionTimings,
  RuntimeProvider,
} from "@/lib/runtime/types";

/** Shared bare mirror on the box; per-workspace worktrees branch off this. */
export const MIRROR_PATH = "/home/runtime/repo.git";

const DEFAULT_SNAPSHOT = "runtime-computer-v1";
const DEFAULT_BINARY_PATH = ".context/build/runtime-agent-linux-amd64";
/** Longer than a cold snapshot pull; the spike measured ~4s warm. */
const CREATE_TIMEOUT_SECONDS = 180;
/** Signed WS preview lifetime; refreshed on reconnect (Spike 1 finding). */
const SIGNED_URL_TTL_SECONDS = 300;

/** Everything the control plane needs to reach a freshly provisioned box. */
export type ProvisionedComputer = {
  sandboxId: string;
  /** Standard preview URL base for control calls (preview token sent as header). */
  agentBaseUrl: string;
  /** Daytona preview token for the control base. */
  daytonaPreviewToken: string;
  /** Signed preview URL base for the browser WS (token already in the host). */
  signedWsBaseUrl: string;
  timings: ProvisionTimings;
};

export type ProvisionComputerInput = {
  /** Per-computer secret (runtime_computers.agent_secret) the agent verifies. */
  secret: string;
  /** When set, seed the bare mirror so worktrees can be created immediately. */
  repoFullName?: string;
  githubToken?: string;
  /** Project secrets delivered into the agent's memory at launch and injected
   *  into each Claude session's env (e.g. CLAUDE_CODE_OAUTH_TOKEN). Never at
   *  rest on the box — in-memory only, not written to disk or archived.
   *  TODO(M3): replace launch-time env injection with runtime-agent secret
   *  provisioning (a dedicated delivery channel), so per-workspace secrets don't
   *  ride the boot env. */
  sessionEnv?: Record<string, string>;
  /** Optional live per-stage progress (the UI/verify script logs these). */
  onStage?: (stage: ProvisionStage, ms: number) => void;
};

/**
 * The Daytona backend — Runtime's real compute model: one always-on box per
 * Project (the Runtime Computer), with workspaces living inside it as tmux
 * sessions/worktrees. This is NOT Modal's workspace-per-sandbox shape, so the
 * class is deliberately split:
 *
 *  - The honest, tested surface is the **Runtime Computer lifecycle**:
 *    {@link provisionComputer} (create box + deploy agent + seed mirror, all
 *    timed), {@link computerAlive}, {@link destroyComputer}, {@link agentTarget}.
 *    Workspace/session operations run through {@link AgentClient}, not here.
 *
 *  - The workspace-centric {@link RuntimeProvider} methods below are the Modal
 *    shape. The batch/SSE ones are **retired** (M2 pt3 deletes them); the rest
 *    are driven through the agent and are wired at the route layer, not the
 *    provider. Both throw a clear error rather than pretend to work.
 *
 * The `RuntimeProvider` implementation exists only so provider selection
 * (`provider.ts`/`resolve.ts`) type-checks during the transition.
 */
export class DaytonaRuntimeProvider implements RuntimeProvider {
  readonly name = "daytona" as const;

  private client: Daytona | null = null;
  private agentBinary: Buffer | null = null;

  /** Lazy so constructing the provider (e.g. in a test) needs no credentials. */
  private daytona(): Daytona {
    if (!this.client) {
      this.client = new Daytona({
        apiKey: requireEnv("DAYTONA_API_KEY"),
        apiUrl: optionalEnv("DAYTONA_API_URL"),
        target: optionalEnv("DAYTONA_TARGET"),
      });
    }
    return this.client;
  }

  private snapshot(): string {
    return optionalEnv("DAYTONA_SNAPSHOT") ?? DEFAULT_SNAPSHOT;
  }

  /** Read (and cache) the cross-compiled agent uploaded on each provision. */
  private async binary(): Promise<Buffer> {
    if (!this.agentBinary) {
      const configured = optionalEnv("RUNTIME_AGENT_BINARY_PATH");
      const binaryPath = configured
        ? path.resolve(configured)
        : path.resolve(process.cwd(), DEFAULT_BINARY_PATH);
      try {
        this.agentBinary = await readFile(binaryPath);
      } catch (error) {
        throw new Error(
          `Cannot read runtime-agent binary at ${binaryPath}. Cross-compile it ` +
            `(GOOS=linux GOARCH=amd64 …) or set RUNTIME_AGENT_BINARY_PATH. Cause: ${
              (error as Error).message
            }`,
        );
      }
    }
    return this.agentBinary;
  }

  /** BoxIO for the deploy module: run a command / launch a daemon / upload
   *  bytes on one box. `launch` goes through a background session with
   *  `runAsync` because a synchronous executeCommand never returns while the
   *  daemon it started keeps running (the provisioning spike's `agent_boot`
   *  hang). */
  private boxIO(sandbox: Sandbox): BoxIO {
    return {
      exec: async (command) => {
        const res = await sandbox.process.executeCommand(command);
        return { stdout: res.result ?? "", exitCode: res.exitCode ?? 0 };
      },
      launch: async (command) => {
        const sessionId = `runtime-agent-launch-${sandbox.id}`;
        await sandbox.process.createSession(sessionId).catch(() => {
          /* session already exists — reuse it */
        });
        await sandbox.process.executeSessionCommand(sessionId, {
          command,
          runAsync: true,
        });
      },
      upload: (data, remotePath) => sandbox.fs.uploadFile(data, remotePath),
    };
  }

  /** GitExec for the shared git module, backed by the box's shell. Argv is
   *  shell-quoted and wrapped in `bash -lc`; the credential token rides in the
   *  process env (never in argv), exactly as on the local/modal paths. */
  private gitExec(sandbox: Sandbox): GitExec {
    return async (argv, options) => {
      const inner = argv.map(shellQuote).join(" ");
      const res = await sandbox.process.executeCommand(
        `bash -lc ${shellQuote(inner)}`,
        undefined,
        options?.env,
      );
      return { stdout: res.result ?? "", stderr: "", exitCode: res.exitCode ?? 0 };
    };
  }

  // --- Runtime Computer lifecycle (the honest Daytona surface) --------------

  /**
   * Provision the always-on box from the frozen snapshot, deploy the agent
   * (decision 1A: gzip → upload → gunzip → launch → health), and optionally
   * seed the bare mirror. Every stage is timed. On any failure the half-built
   * sandbox is deleted so a retry starts clean.
   */
  async provisionComputer(
    input: ProvisionComputerInput,
  ): Promise<ProvisionedComputer> {
    const daytona = this.daytona();
    const binary = await this.binary();
    const timer = new ProvisionTimer({
      onStage: (t) => input.onStage?.(t.stage, t.ms),
    });

    let sandbox: Sandbox | null = null;
    try {
      sandbox = await timer.stage("sandbox_create", () =>
        daytona.create(
          {
            snapshot: this.snapshot(),
            // Always-on for V1: never auto-stop, never auto-delete, no TTL.
            autoStopInterval: 0,
            autoDeleteInterval: -1,
            labels: { "runtime.role": "computer" },
          },
          { timeout: CREATE_TIMEOUT_SECONDS },
        ),
      );
      const box = sandbox;
      const io = this.boxIO(box);

      await timer.stage("agent_upload", () => uploadAgent(io, binary));
      await timer.stage("agent_boot", () =>
        bootAgent(io, input.secret, input.sessionEnv),
      );
      await timer.stage("health_check", () => waitForAgentHealth(io));

      if (input.repoFullName) {
        await timer.stage("mirror_clone", () =>
          cloneMirror(this.gitExec(box), {
            repoFullName: input.repoFullName!,
            dir: MIRROR_PATH,
            token: input.githubToken,
          }),
        );
      }

      const preview = await this.previewUrls(box);
      return { sandboxId: box.id, ...preview, timings: timer.timings() };
    } catch (error) {
      if (sandbox) {
        await daytona
          .delete(sandbox)
          .catch((cleanupError: unknown) =>
            console.error("Could not delete failed Daytona computer", cleanupError),
          );
      }
      throw error;
    }
  }

  /** Refresh the shared mirror before creating a new worktree. */
  async fetchMirror(sandboxId: string, githubToken?: string): Promise<void> {
    const sandbox = await this.daytona().get(sandboxId);
    await fetchMirror(this.gitExec(sandbox), {
      repoDir: MIRROR_PATH,
      token: githubToken,
    });
  }

  /** Whether the box is still up and able to host sessions. */
  async computerAlive(sandboxId: string): Promise<boolean> {
    if (!sandboxId) return false;
    try {
      const sandbox = await this.daytona().get(sandboxId);
      return sandbox.state === "started";
    } catch (error) {
      console.error(`Could not read Daytona computer ${sandboxId}`, error);
      return false;
    }
  }

  /** Tear the box down (destroys all worktrees/sessions inside it). */
  async destroyComputer(sandboxId: string): Promise<void> {
    if (!sandboxId) return;
    try {
      const sandbox = await this.daytona().get(sandboxId);
      await this.daytona().delete(sandbox);
    } catch (error) {
      // Already gone is success from the caller's perspective.
      console.error(`Could not delete Daytona computer ${sandboxId}`, error);
    }
  }

  /** Build the {@link AgentTarget} an {@link AgentClient} needs for one box. */
  async agentTarget(sandboxId: string, secret: string): Promise<AgentTarget> {
    const sandbox = await this.daytona().get(sandboxId);
    const preview = await this.previewUrls(sandbox);
    return {
      controlBaseUrl: preview.agentBaseUrl,
      daytonaPreviewToken: preview.daytonaPreviewToken,
      signedWsBaseUrl: preview.signedWsBaseUrl,
      secret,
    };
  }

  /** Both preview URL flavors for the agent port: standard (control, header
   *  token) and signed (browser WS, token in the host). */
  private async previewUrls(sandbox: Sandbox): Promise<{
    agentBaseUrl: string;
    daytonaPreviewToken: string;
    signedWsBaseUrl: string;
  }> {
    const [preview, signed] = await Promise.all([
      sandbox.getPreviewLink(AGENT_PORT),
      sandbox.getSignedPreviewUrl(AGENT_PORT, SIGNED_URL_TTL_SECONDS),
    ]);
    return {
      agentBaseUrl: preview.url,
      daytonaPreviewToken: preview.token,
      signedWsBaseUrl: signed.url,
    };
  }

  // --- RuntimeProvider interface --------------------------------------------
  // Workspace/session operations run through AgentClient (wired at the route
  // layer), not the provider. These implementations intentionally take no
  // arguments — a narrower signature still satisfies the interface — because
  // every one throws.

  createWorkspace(): Promise<CreateWorkspaceResult> {
    return notWiredYet("createWorkspace");
  }

  resumeWorkspace(): Promise<{ sandboxId: string }> {
    return notWiredYet("resumeWorkspace");
  }

  sandboxAlive(): Promise<boolean> {
    return notWiredYet("sandboxAlive");
  }

  listChangedFiles(): Promise<ChangedFile[]> {
    return notWiredYet("listChangedFiles");
  }

  readChangedFileDiff(): Promise<string> {
    return notWiredYet("readChangedFileDiff");
  }

  commitWorkspace(): Promise<CommitWorkspaceResult> {
    return notWiredYet("commitWorkspace");
  }

  pushWorkspaceBranch(): Promise<void> {
    return notWiredYet("pushWorkspaceBranch");
  }

  suspendWorkspace(): Promise<void> {
    return notWiredYet("suspendWorkspace");
  }

  destroyWorkspace(): Promise<void> {
    return notWiredYet("destroyWorkspace");
  }

  createPullRequest(): Promise<CreatePullRequestResult> {
    return notWiredYet("createPullRequest");
  }
}

function notWiredYet(op: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${op} is not on the Daytona provider — interactive workspaces are driven ` +
        `through AgentClient (wired at the route layer in M2 pt3 / M3).`,
    ),
  );
}
