/**
 * Domain model + RuntimeProvider contract.
 *
 * The browser is only the control plane; every provider implementation below
 * is responsible for actually executing work somewhere else (Modal in
 * production, a local directory in development).
 */

// ---------------------------------------------------------------------------
// Domain model (mirrors the `projects`, `workspaces`, `jobs` tables)
// ---------------------------------------------------------------------------

export type Project = {
  id: string;
  githubRepoId: number;
  /** `owner/name`, e.g. `immadsahin/runtime`. */
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  /** Canonical GitHub repository page. */
  htmlUrl: string;
  pushedAt: string | null;
  /** Linear issues attached to this project (never standalone projects). */
  linearIssueIds: string[];
  createdAt: string;
  updatedAt: string;
};

/**
 * Lifecycle: creating -> provisioning -> ready(claude_ready) -> idle
 *            -> suspending -> suspended -> resuming -> ready -> destroying
 *            -> destroyed
 * M4 archive/restore: ready/idle -> archiving -> archived -> restoring -> ready.
 */
export type WorkspaceStatus =
  | "creating"
  | "provisioning"
  | "ready"
  | "idle"
  | "suspending"
  | "resuming"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "archiving"
  | "archived"
  | "restoring"
  | "failed";

/** Ordered provisioning phases, surfaced in the UI as a checklist. */
export type ProvisionPhase =
  | "allocate"
  | "clone"
  | "worktree"
  | "secrets"
  | "install"
  | "health_check"
  | "claude_ready";

/**
 * Backend that owns a workspace's compute. `local`/`modal` are the workspace-per-
 * sandbox model; `daytona` is Runtime's real model (Project → Runtime Computer →
 * Workspace) where many workspaces share one always-on box.
 */
export type ProviderName = "local" | "modal" | "daytona";

export type Workspace = {
  id: string;
  projectId: string;
  /** Backend that owns this workspace's compute and durable storage. */
  provider: ProviderName;
  status: WorkspaceStatus;
  phase: ProvisionPhase | null;
  /** Branch checked out in the git worktree. */
  branch: string;
  baseBranch: string;
  /** Absolute path of the worktree inside the sandbox. */
  worktreePath: string;
  /** Current sandbox handle; null while suspended. Sandboxes are disposable. */
  sandboxId: string | null;
  /** Durable storage handle (Modal Volume) that survives sandbox death. */
  volumeName: string | null;
  /** Runtime Computer this workspace runs on; null when not yet attached. */
  computerId: string | null;
  /** tmux session name on the Runtime Computer that hosts this Claude session. */
  tmuxSession: string | null;
  /** Agent-side workspace identifier, as known to the runtime-agent. */
  agentWorkspaceId: string | null;
  lastActiveAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Runtime Computer: one long-lived Daytona Ubuntu box per Project, built from a
 * frozen versioned image. Provisioned lazily on the first workspace and kept
 * warm. Workspaces run inside it as tmux sessions.
 */
export type RuntimeComputerStatus =
  | "provisioning"
  | "ready"
  | "error"
  | "stopped";

/**
 * Ordered stages of Runtime Computer provisioning. Measured on every provision
 * and persisted (see {@link ProvisionTimings}) so that "workspace creation feels
 * slow" can be traced to the exact stage that regressed instead of guessed at.
 */
export type ProvisionStage =
  | "sandbox_create"
  | "agent_upload"
  | "agent_boot"
  | "health_check"
  | "mirror_clone";

export type StageTiming = { stage: ProvisionStage; ms: number };

/** Per-provision timing record, stored on the Runtime Computer row. */
export type ProvisionTimings = {
  stages: StageTiming[];
  totalMs: number;
};

export type RuntimeComputer = {
  id: string;
  projectId: string;
  status: RuntimeComputerStatus;
  /** Frozen image tag this box was built from, e.g. `v1`. */
  imageVersion: string;
  /** Daytona sandbox id; null until compute is provisioned. */
  daytonaSandboxId: string | null;
  /** Base of the Daytona preview URL the runtime-agent is reachable at. */
  agentBaseUrl: string | null;
  /** Wall-clock breakdown of the last provision; null until first measured. */
  provisionTimings: ProvisionTimings | null;
  errorMessage: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobAgent = "claude" | "codex";

/**
 * Historical job record. The batch execution mechanism that produced these was
 * retired in M2 pt3; the table + type are kept as the seed for the interactive
 * session record (M3), so the log/result/handle fields are now vestigial.
 */
export type Job = {
  id: string;
  workspaceId: string;
  agent: JobAgent;
  status: JobStatus;
  prompt: string;
  logPath: string;
  /** Provider-owned completion record; never supplied by the browser. */
  resultPath: string;
  executionHandle: string | null;
  logBytes: number;
  exitCode: number | null;
  /** Claude Code session id, so follow-up jobs can `--resume`. */
  sessionId: string | null;
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type WorkspacePullRequest = {
  id: string;
  workspaceId: string;
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
};

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
};

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export type CreateWorkspaceInput = {
  workspaceId: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  /** Secrets injected into the sandbox environment. */
  env: Record<string, string>;
  /** Optional install command override; inferred when omitted. */
  installCommand?: string;
  onPhase?: (phase: ProvisionPhase) => void | Promise<void>;
};

export type CreateWorkspaceResult = {
  sandboxId: string;
  volumeName: string;
  worktreePath: string;
  /** Non-fatal provisioning problems that should be shown before a job runs. */
  warnings: string[];
};

export type CreatePullRequestInput = {
  workspaceId: string;
  sandboxId: string;
  repoFullName: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
};

export type CreatePullRequestResult = {
  url: string;
  number: number;
};

export type CommitWorkspaceInput = {
  workspaceId: string;
  sandboxId: string;
  message: string;
  author: { name: string; email: string };
};

export type CommitWorkspaceResult = { sha: string };

export type PushWorkspaceBranchInput = {
  workspaceId: string;
  sandboxId: string;
  repoFullName: string;
  branch: string;
  githubToken: string;
};

/**
 * Every execution backend implements this. Swapping `RUNTIME_PROVIDER`
 * between `local` and `modal` must not require any API or UI change.
 */
export interface RuntimeProvider {
  readonly name: ProviderName;

  createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult>;

  /** Re-attach durable storage to a fresh sandbox. */
  resumeWorkspace(input: {
    workspaceId: string;
    volumeName: string;
    env: Record<string, string>;
  }): Promise<{ sandboxId: string }>;

  /**
   * Whether a previously-created sandbox handle still exists and can run work.
   * Disposable sandboxes (Modal expires them at 24h) may be gone even though the
   * workspace row still records their id; callers use this to decide whether to
   * resume onto fresh compute before starting a job or terminal.
   */
  sandboxAlive(sandboxId: string): Promise<boolean>;

  /** Workspace changes compared with the worktree's current branch HEAD. */
  listChangedFiles(input: {
    workspaceId: string;
    sandboxId: string;
  }): Promise<ChangedFile[]>;

  /** A bounded, text-only diff for one provider-validated changed file. */
  readChangedFileDiff(input: {
    workspaceId: string;
    sandboxId: string;
    path: string;
  }): Promise<string>;

  commitWorkspace(input: CommitWorkspaceInput): Promise<CommitWorkspaceResult>;

  /** Push only the persisted project branch using an operation-scoped token. */
  pushWorkspaceBranch(input: PushWorkspaceBranchInput): Promise<void>;

  /** Stop compute, keep durable storage. */
  suspendWorkspace(input: {
    workspaceId: string;
    sandboxId: string;
  }): Promise<void>;

  /** Stop compute and delete durable storage. */
  destroyWorkspace(input: {
    workspaceId: string;
    sandboxId: string | null;
    volumeName: string | null;
  }): Promise<void>;

  createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult>;
}
