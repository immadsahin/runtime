import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Daytona, type Sandbox } from "@daytonaio/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import type { AgentTarget } from "@/lib/runtime/agent-client";
import {
  AGENT_PORT,
  bootAgent,
  type BoxIO,
  deployJcode,
  ProvisionTimer,
  shellQuote,
  uploadAgent,
  waitForAgentHealth,
} from "@/lib/runtime/daytona/deploy";
import {
  cloneMirror,
  commitAll,
  fetchMirror,
  listChangedFiles,
  pushBranch,
  readFileDiff,
  type GitExec,
} from "@/lib/runtime/git";
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

/** Monotonic suffix so each detached launch gets its own Daytona session. */
let launchSeq = 0;

/**
 * Read the jcode subscription credential the control plane injects into each
 * box.
 *
 * Two sources, in priority order:
 *  1. Inline base64 env vars `JCODE_AUTH_JSON` (+ optional
 *     `JCODE_AUTH_REFRESH_JSON`) — for a hosted control plane (e.g. Railway)
 *     that has no `~/.jcode` on disk. Each is the base64 of the corresponding
 *     jcode file.
 *  2. The operator's `~/.jcode` directory (where `jcode login` stored it),
 *     overridable with `JCODE_AUTH_DIR` — the local-dev path.
 *
 * Throws a clear error if neither is present.
 */
/**
 * Decode a base64 jcode credential from an env var, failing loudly on bad input.
 *
 * `Buffer.from(_, "base64")` is lenient: it silently drops invalid characters
 * and stops at the first padding, so a truncated or corrupted paste decodes to
 * garbage that we'd upload as `auth.json` — surfacing only much later as an
 * opaque authentication error on the box. We reject anything that doesn't
 * round-trip as clean base64, and — since both jcode credential files are JSON —
 * anything that doesn't decode to parseable JSON. Whitespace/newlines in the env
 * value are tolerated (a wrapped base64 paste is still valid).
 */
export function decodeBase64Credential(name: string, value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(
      `${name} is not valid base64. Re-encode the file with \`base64 < <file>\`.`,
    );
  }
  try {
    JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error(
      `${name} did not decode to valid JSON — the base64 is likely truncated or ` +
        `not the credential file.`,
    );
  }
  return decoded;
}

function readJcodeCreds(): { authJson: Buffer; refreshJson?: Buffer } {
  const inlineAuth = optionalEnv("JCODE_AUTH_JSON");
  if (inlineAuth) {
    const inlineRefresh = optionalEnv("JCODE_AUTH_REFRESH_JSON");
    return {
      authJson: decodeBase64Credential("JCODE_AUTH_JSON", inlineAuth),
      refreshJson: inlineRefresh
        ? decodeBase64Credential("JCODE_AUTH_REFRESH_JSON", inlineRefresh)
        : undefined,
    };
  }

  const dir = optionalEnv("JCODE_AUTH_DIR") ?? path.join(os.homedir(), ".jcode");
  const authPath = path.join(dir, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(
      `jcode credential not found. Set JCODE_AUTH_JSON (base64 of auth.json) for a ` +
        `hosted deploy, or run \`jcode login --provider claude\` / set JCODE_AUTH_DIR ` +
        `to the directory holding auth.json (looked in ${authPath}).`,
    );
  }
  const refreshPath = path.join(dir, "auth-refresh-state.json");
  return {
    authJson: readFileSync(authPath),
    refreshJson: existsSync(refreshPath) ? readFileSync(refreshPath) : undefined,
  };
}

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
        // A UNIQUE session per launch: the jcode path launches two daemons
        // (bridge + agent), and reusing one session id makes the second command
        // collide with the still-running first and silently not execute.
        launchSeq += 1;
        const sessionId = `runtime-launch-${sandbox.id}-${launchSeq}`;
        await sandbox.process.createSession(sessionId).catch(() => {});
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
    if (optionalEnv("RUNTIME_ENGINE") === "jcode") {
      return this.provisionJcodeComputer(input);
    }
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

  /**
   * jcode-engine provisioning: a DEFAULT Daytona image (the frozen
   * runtime-computer-v1 snapshot isn't in every account), with jcode installed
   * on-provision, the subscription credential injected, the api-bridge started,
   * and the agent launched in jcode mode. The recipe (incl. the USER/XDG/pinned
   * -socket fix) lives in deployJcode; validated on real Daytona.
   */
  private async provisionJcodeComputer(
    input: ProvisionComputerInput,
  ): Promise<ProvisionedComputer> {
    const daytona = this.daytona();
    const binary = await this.binary();
    const creds = readJcodeCreds();
    const timer = new ProvisionTimer({
      onStage: (t) => input.onStage?.(t.stage, t.ms),
    });

    let sandbox: Sandbox | null = null;
    try {
      sandbox = await timer.stage("sandbox_create", () =>
        daytona.create(
          {
            // Always-on retention: never sleep, never delete. The box + its
            // disk (worktrees, jcode sessions, conversation logs) stay live, so
            // reconnect/resume just works with no wake path. Cheap for one
            // project on the current credits; revisit sleep+wake at scale.
            autoStopInterval: 0,
            autoDeleteInterval: -1,
            labels: { "runtime.role": "computer", "runtime.engine": "jcode" },
          },
          { timeout: CREATE_TIMEOUT_SECONDS },
        ),
      );
      const box = sandbox;
      const io = this.boxIO(box);
      // Default images aren't /home/runtime; the agent + mirror hang off $HOME.
      const home =
        ((await io.exec("bash -lc 'echo $HOME'")).stdout || "").trim() || "/home/daytona";

      await timer.stage("agent_boot", () =>
        deployJcode(io, binary, input.secret, {
          root: home,
          authJson: creds.authJson,
          refreshJson: creds.refreshJson,
        }),
      );

      if (input.repoFullName) {
        await timer.stage("mirror_clone", () =>
          cloneMirror(this.gitExec(box), {
            repoFullName: input.repoFullName!,
            // Agent RUNTIME_AGENT_ROOT=home, so its mirror is $HOME/repo.git.
            dir: `${home}/repo.git`,
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
            console.error("Could not delete failed jcode computer", cleanupError),
          );
      }
      throw error;
    }
  }

  /** Refresh the shared mirror before creating a new worktree. */
  async fetchMirror(sandboxId: string, githubToken?: string): Promise<void> {
    const sandbox = await this.daytona().get(sandboxId);
    await fetchMirror(this.gitExec(sandbox), {
      repoDir: await this.mirrorDir(sandbox),
      token: githubToken,
    });
  }

  /**
   * The bare-mirror path on the box. The Claude snapshot fixes it at
   * /home/runtime; the jcode path runs on a default image whose home differs
   * (and whose mirror provisionJcodeComputer cloned to $HOME/repo.git), so
   * resolve it from the box's actual home.
   */
  private async mirrorDir(sandbox: Sandbox): Promise<string> {
    if (optionalEnv("RUNTIME_ENGINE") === "jcode") {
      const home =
        ((await sandbox.process.executeCommand("bash -lc 'echo $HOME'")).result || "").trim() ||
        "/home/daytona";
      return `${home}/repo.git`;
    }
    return MIRROR_PATH;
  }

  /** Git projection for one interactive worktree on the shared computer. */
  async listWorkspaceChangedFiles(
    sandboxId: string,
    worktreePath: string,
  ): Promise<ChangedFile[]> {
    const sandbox = await this.daytona().get(sandboxId);
    return listChangedFiles(this.gitExec(sandbox), { worktree: worktreePath });
  }

  /** Bounded diff for one changed path in an interactive worktree. */
  async readWorkspaceChangedFileDiff(
    sandboxId: string,
    worktreePath: string,
    filePath: string,
  ): Promise<string> {
    const sandbox = await this.daytona().get(sandboxId);
    return readFileDiff(this.gitExec(sandbox), {
      worktree: worktreePath,
      path: filePath,
    });
  }

  /** Commit all current changes in a Runtime worktree. */
  async commitWorkspaceChanges(
    sandboxId: string,
    worktreePath: string,
    input: { message: string; author: { name: string; email: string } },
  ): Promise<CommitWorkspaceResult> {
    const sandbox = await this.daytona().get(sandboxId);
    return commitAll(this.gitExec(sandbox), { worktree: worktreePath, ...input });
  }

  /** Push an interactive worktree's persisted branch with a request-scoped token. */
  async pushWorkspaceChanges(
    sandboxId: string,
    worktreePath: string,
    input: { repoFullName: string; branch: string; githubToken: string },
  ): Promise<void> {
    const sandbox = await this.daytona().get(sandboxId);
    await pushBranch(this.gitExec(sandbox), {
      worktree: worktreePath,
      repoFullName: input.repoFullName,
      branch: input.branch,
      token: input.githubToken,
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
