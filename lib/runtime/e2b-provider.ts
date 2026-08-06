import { readFile } from "node:fs/promises";
import path from "node:path";

import { Sandbox } from "e2b";

import { optionalEnv, requireEnv } from "@/lib/env";
import type {
  AgentTarget,
  ComputeProvider,
  ProvisionComputerInput,
  ProvisionedComputer,
} from "@/lib/runtime/compute-provider";
import {
  AGENT_PORT,
  bootAgent,
  type BoxIO,
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
  RuntimeProvider,
} from "@/lib/runtime/types";

/** Each isolated E2B Runtime Computer owns its own bare mirror. */
export const E2B_MIRROR_PATH = "/home/runtime/repo.git";

const DEFAULT_TEMPLATE = "runtime-computer-e2b-v1";
const DEFAULT_BINARY_PATH = ".context/build/runtime-agent-linux-amd64";
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

type E2BCommandResult = { stdout: string; stderr: string; exitCode: number };

/** The small SDK surface Runtime needs, injectable for provider contract tests. */
export type E2BSandbox = {
  sandboxId: string;
  commands: {
    run: (
      command: string,
      options?: { background?: boolean; envs?: Record<string, string> },
    ) => Promise<E2BCommandResult | unknown>;
  };
  files: {
    write: (
      remotePath: string,
      data: string | ArrayBuffer | Blob | ReadableStream,
    ) => Promise<unknown>;
  };
  getHost: (port: number) => string;
  isRunning: () => Promise<boolean>;
};

export type E2BSandboxClient = {
  create: (
    template: string,
    options: {
      apiKey: string;
      timeoutMs: number;
      metadata: Record<string, string>;
      lifecycle: {
        onTimeout: { action: "pause"; keepMemory: boolean };
      };
    },
  ) => Promise<E2BSandbox>;
  connect: (sandboxId: string, options: { apiKey: string }) => Promise<E2BSandbox>;
  getInfo: (sandboxId: string, options: { apiKey: string }) => Promise<{ state: string }>;
  pause: (sandboxId: string, options: { apiKey: string }) => Promise<boolean>;
  kill: (sandboxId: string, options: { apiKey: string }) => Promise<boolean>;
};

const sandboxClient: E2BSandboxClient = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  getInfo: (sandboxId, options) => Sandbox.getInfo(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
};

/** E2B `getHost` returns a hostname, not an already-qualified URL. */
export function e2bAgentBaseUrl(host: string): string {
  return /^https?:\/\//.test(host) ? host.replace(/\/$/, "") : `https://${host}`;
}

/**
 * Isolated E2B Runtime Computer provider.
 *
 * E2B controller access stays in this file and is always server-side. Public
 * agent traffic has no E2B credential: agent requests are authorized with the
 * existing short-lived Runtime JWT in AgentClient instead.
 */
export class E2BRuntimeProvider implements RuntimeProvider, ComputeProvider {
  readonly name = "e2b" as const;
  readonly kind = "compute" as const;
  readonly topology = "isolated" as const;

  private agentBinary: Buffer | null = null;
  private readonly client: E2BSandboxClient;

  constructor(client: E2BSandboxClient = sandboxClient) {
    this.client = client;
  }

  private apiKey(): string {
    return requireEnv("E2B_API_KEY");
  }

  private template(): string {
    return optionalEnv("E2B_TEMPLATE") ?? DEFAULT_TEMPLATE;
  }

  placementVersion(): string {
    return this.template();
  }

  private timeoutMs(): number {
    const configured = optionalEnv("E2B_SANDBOX_TIMEOUT_MS");
    if (!configured) return DEFAULT_TIMEOUT_MS;
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("E2B_SANDBOX_TIMEOUT_MS must be a positive integer in milliseconds.");
    }
    return parsed;
  }

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
            `(GOOS=linux GOARCH=amd64 …) or set RUNTIME_AGENT_BINARY_PATH. Cause: ${(error as Error).message}`,
        );
      }
    }
    return this.agentBinary;
  }

  private boxIO(sandbox: E2BSandbox): BoxIO {
    return {
      exec: async (command) => {
        const result = await sandbox.commands.run(command) as E2BCommandResult;
        return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`, exitCode: result.exitCode ?? 0 };
      },
      launch: async (command) => {
        await sandbox.commands.run(command, { background: true });
      },
      upload: async (data, remotePath) => {
        await sandbox.files.write(remotePath, new Blob([new Uint8Array(data)]));
      },
    };
  }

  private gitExec(sandbox: E2BSandbox): GitExec {
    return async (argv, options) => {
      const command = `bash -lc ${shellQuote(argv.map(shellQuote).join(" "))}`;
      const result = await sandbox.commands.run(command, { envs: options?.env }) as E2BCommandResult;
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    };
  }

  async provisionComputer(input: ProvisionComputerInput): Promise<ProvisionedComputer> {
    const binary = await this.binary();
    const apiKey = this.apiKey();
    const timer = new ProvisionTimer({ onStage: (timing) => input.onStage?.(timing.stage, timing.ms) });
    let sandbox: E2BSandbox | null = null;

    try {
      sandbox = await timer.stage("sandbox_create", () =>
        this.client.create(this.template(), {
          apiKey,
          timeoutMs: this.timeoutMs(),
          metadata: { ...input.labels, "runtime.role": "computer", "runtime.topology": "isolated" },
          // A Runtime workspace retains its immutable placement across an E2B
          // timeout. Preserve its process state and require its explicit
          // lifecycle Resume action rather than letting E2B terminate it.
          lifecycle: { onTimeout: { action: "pause", keepMemory: true } },
        }),
      );
      const io = this.boxIO(sandbox);
      await timer.stage("agent_upload", () => uploadAgent(io, binary));
      await timer.stage("agent_boot", () => bootAgent(io, input.secret, input.sessionEnv));
      await timer.stage("health_check", () => waitForAgentHealth(io));
      if (input.repoFullName) {
        await timer.stage("mirror_clone", () =>
          cloneMirror(this.gitExec(sandbox!), {
            repoFullName: input.repoFullName!,
            dir: E2B_MIRROR_PATH,
            token: input.githubToken,
          }),
        );
      }
      const baseUrl = e2bAgentBaseUrl(sandbox.getHost(AGENT_PORT));
      return {
        computerId: sandbox.sandboxId,
        controlBaseUrl: baseUrl,
        controlHeaders: {},
        browserBaseUrl: baseUrl,
        timings: timer.timings(),
      };
    } catch (error) {
      if (sandbox) {
        try {
          await this.destroyComputer(sandbox.sandboxId);
        } catch (cleanupError) {
          // The database row cannot yet hold a provider id because the agent
          // never became ready. Surface the exact sandbox id in the error and
          // preserve both causes so an operator can clean it up immediately.
          throw new AggregateError(
            [error, cleanupError],
            `E2B provisioning failed and cleanup also failed for ${sandbox.sandboxId}.`,
          );
        }
      }
      throw error;
    }
  }

  async computerAlive(computerId: string): Promise<boolean> {
    if (!computerId) return false;
    try {
      const state = (await this.client.getInfo(computerId, { apiKey: this.apiKey() })).state;
      // A paused isolated computer still owns its immutable placement and can
      // be resumed in place; only a missing/terminated resource is stale.
      return state === "running" || state === "paused";
    } catch (error) {
      console.error(`Could not read E2B computer ${computerId}`, error);
      return false;
    }
  }

  /** Pause preserves the isolated sandbox's memory and filesystem. */
  async pauseComputer(computerId: string): Promise<void> {
    if (computerId) await this.client.pause(computerId, { apiKey: this.apiKey() });
  }

  /** Connecting a paused E2B sandbox resumes the same immutable placement. */
  async resumeComputer(computerId: string): Promise<void> {
    if (computerId) await this.client.connect(computerId, { apiKey: this.apiKey() });
  }

  async destroyComputer(computerId: string): Promise<void> {
    if (!computerId) return;
    // Do not hide a provider deletion failure. Callers must keep the persisted
    // placement/workspace retryable rather than reporting an orphaned billed
    // sandbox as successfully destroyed.
    const deleted = await this.client.kill(computerId, { apiKey: this.apiKey() });
    if (!deleted) {
      throw new Error(`E2B did not confirm deletion of computer ${computerId}.`);
    }
  }

  async agentTarget(computerId: string, secret: string): Promise<AgentTarget> {
    const sandbox = await this.client.connect(computerId, { apiKey: this.apiKey() });
    const baseUrl = e2bAgentBaseUrl(sandbox.getHost(AGENT_PORT));
    return { controlBaseUrl: baseUrl, controlHeaders: {}, browserBaseUrl: baseUrl, secret };
  }

  async fetchMirror(computerId: string, githubToken?: string): Promise<void> {
    const sandbox = await this.client.connect(computerId, { apiKey: this.apiKey() });
    await fetchMirror(this.gitExec(sandbox), { repoDir: E2B_MIRROR_PATH, token: githubToken });
  }

  async listWorkspaceChangedFiles(computerId: string, worktreePath: string): Promise<ChangedFile[]> {
    const sandbox = await this.client.connect(computerId, { apiKey: this.apiKey() });
    return listChangedFiles(this.gitExec(sandbox), { worktree: worktreePath });
  }

  async readWorkspaceChangedFileDiff(
    computerId: string,
    worktreePath: string,
    filePath: string,
  ): Promise<string> {
    const sandbox = await this.client.connect(computerId, { apiKey: this.apiKey() });
    return readFileDiff(this.gitExec(sandbox), { worktree: worktreePath, path: filePath });
  }

  async commitWorkspaceChanges(
    computerId: string,
    worktreePath: string,
    input: { message: string; author: { name: string; email: string } },
  ): Promise<CommitWorkspaceResult> {
    const sandbox = await this.client.connect(computerId, { apiKey: this.apiKey() });
    return commitAll(this.gitExec(sandbox), { worktree: worktreePath, ...input });
  }

  async pushWorkspaceChanges(
    computerId: string,
    worktreePath: string,
    input: { repoFullName: string; branch: string; githubToken: string },
  ): Promise<void> {
    const sandbox = await this.client.connect(computerId, { apiKey: this.apiKey() });
    await pushBranch(this.gitExec(sandbox), {
      worktree: worktreePath,
      repoFullName: input.repoFullName,
      branch: input.branch,
      token: input.githubToken,
    });
  }

  // The existing RuntimeProvider adapter is retained only during the ongoing
  // route migration. Compute-backed workspaces run through AgentClient.
  createWorkspace(): Promise<CreateWorkspaceResult> { return notWiredYet("createWorkspace"); }
  resumeWorkspace(): Promise<{ sandboxId: string }> { return notWiredYet("resumeWorkspace"); }
  sandboxAlive(): Promise<boolean> { return notWiredYet("sandboxAlive"); }
  listChangedFiles(): Promise<ChangedFile[]> { return notWiredYet("listChangedFiles"); }
  readChangedFileDiff(): Promise<string> { return notWiredYet("readChangedFileDiff"); }
  commitWorkspace(): Promise<CommitWorkspaceResult> { return notWiredYet("commitWorkspace"); }
  pushWorkspaceBranch(): Promise<void> { return notWiredYet("pushWorkspaceBranch"); }
  suspendWorkspace(): Promise<void> { return notWiredYet("suspendWorkspace"); }
  destroyWorkspace(): Promise<void> { return notWiredYet("destroyWorkspace"); }
  createPullRequest(): Promise<CreatePullRequestResult> { return notWiredYet("createPullRequest"); }
}

function notWiredYet(operation: string): Promise<never> {
  return Promise.reject(
    new Error(`${operation} is not on the E2B provider — compute-backed workspaces are driven through AgentClient.`),
  );
}
