/**
 * Provider-neutral contract for computers that host the runtime-agent.
 *
 * A shared computer hosts multiple workspace worktrees; an isolated computer
 * hosts one. Both shapes expose the same agent, lifecycle, and git projection
 * surface to the control plane.
 */

import type {
  ChangedFile,
  CommitWorkspaceResult,
  ProvisionStage,
  ProvisionTimings,
} from "@/lib/runtime/types";

export type ComputeTopology = "shared" | "isolated";

/** Everything the runtime-agent client needs to reach one computer. */
export type AgentTarget = {
  /** Base URL for control-plane requests to the runtime-agent. */
  controlBaseUrl: string;
  /** Provider-specific headers required for control-plane requests. */
  controlHeaders: Record<string, string>;
  /** Base URL the browser can use for PTY and event-stream connections. */
  browserBaseUrl: string;
  /** Per-computer Runtime secret used to mint Runtime tokens. */
  secret: string;
};

export type ProvisionComputerInput = {
  /** Per-computer secret the runtime-agent verifies. */
  secret: string;
  /** Optional provider-visible labels for tracing and lifecycle management. */
  labels?: Record<string, string>;
  /** When set, seed the shared repository mirror before accepting workspaces. */
  repoFullName?: string;
  githubToken?: string;
  /** Secrets held only in the runtime-agent process for workspace sessions. */
  sessionEnv?: Record<string, string>;
  /** Optional live per-stage progress. */
  onStage?: (stage: ProvisionStage, ms: number) => void;
};

/** Provider-neutral result of provisioning a computer and its runtime-agent. */
export type ProvisionedComputer = {
  computerId: string;
  controlBaseUrl: string;
  controlHeaders: Record<string, string>;
  browserBaseUrl: string;
  timings: ProvisionTimings;
};

/**
 * A computer-backed Runtime provider. Provider-specific APIs stay behind this
 * boundary; callers operate on a stable computer id and worktree path.
 */
export interface ComputeProvider {
  readonly kind: "compute";
  readonly topology: ComputeTopology;

  /** Immutable template/snapshot identifier recorded with the placement. */
  placementVersion(): string;

  provisionComputer(input: ProvisionComputerInput): Promise<ProvisionedComputer>;
  computerAlive(computerId: string): Promise<boolean>;
  /** Suspend/resume apply only to isolated computers; shared providers reject them. */
  pauseComputer(computerId: string): Promise<void>;
  resumeComputer(computerId: string): Promise<void>;
  destroyComputer(computerId: string): Promise<void>;
  agentTarget(computerId: string, secret: string): Promise<AgentTarget>;

  /** Refresh a computer's shared mirror before creating a worktree. */
  fetchMirror(computerId: string, githubToken?: string): Promise<void>;
  listWorkspaceChangedFiles(
    computerId: string,
    worktreePath: string,
  ): Promise<ChangedFile[]>;
  readWorkspaceChangedFileDiff(
    computerId: string,
    worktreePath: string,
    filePath: string,
  ): Promise<string>;
  commitWorkspaceChanges(
    computerId: string,
    worktreePath: string,
    input: { message: string; author: { name: string; email: string } },
  ): Promise<CommitWorkspaceResult>;
  pushWorkspaceChanges(
    computerId: string,
    worktreePath: string,
    input: { repoFullName: string; branch: string; githubToken: string },
  ): Promise<void>;
}
