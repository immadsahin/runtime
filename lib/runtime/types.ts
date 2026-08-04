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

export type Workspace = {
  id: string;
  projectId: string;
  /** Backend that owns this workspace's compute and durable storage. */
  provider: "local" | "modal";
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
  lastActiveAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Coding agent that owns one detached job invocation. */
export type JobAgent = "claude" | "codex";

export type Job = {
  id: string;
  workspaceId: string;
  agent: JobAgent;
  status: JobStatus;
  prompt: string;
  /** Log file path on durable storage, tailed by streamLogs. */
  logPath: string;
  /** Provider-owned completion record; never supplied by the browser. */
  resultPath: string;
  /** Detached process identity, when the provider can supply one. */
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

export type ExecuteJobInput = {
  workspaceId: string;
  sandboxId: string;
  jobId: string;
  agent: JobAgent;
  prompt: string;
  /** Narrow Claude credential set, injected only for this command. */
  env: Record<string, string>;
  /** Resume a previous Claude Code session instead of starting fresh. */
  resumeSessionId?: string;
};

export type ExecuteJobResult = {
  /** Logs are written here and tailed asynchronously; execution is detached. */
  logPath: string;
  /** Atomically written by the detached runner when it reaches a terminal state. */
  resultPath: string;
  executionHandle?: string;
};

export type JobPaths = Pick<ExecuteJobResult, "logPath" | "resultPath">;

export type JobResult = {
  status: Extract<JobStatus, "succeeded" | "failed" | "cancelled">;
  exitCode: number | null;
  sessionId?: string;
  costUsd?: number;
  finishedAt: string;
};

export type LogChunk = {
  /** Byte offset AFTER this chunk, used to resume tailing across reconnects. */
  offset: number;
  text: string;
};

export type StreamLogsInput = {
  workspaceId: string;
  sandboxId: string;
  jobId: string;
  logPath: string;
  /** Resume from this byte offset. */
  fromOffset?: number;
  signal?: AbortSignal;
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
  readonly name: "local" | "modal";

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

  executeJob(input: ExecuteJobInput): Promise<ExecuteJobResult>;

  /** Deterministic, provider-owned paths persisted before detached execution. */
  getJobPaths(input: { workspaceId: string; jobId: string }): JobPaths;

  /** Read a provider-owned completion record for a detached job. */
  getJobResult(input: {
    workspaceId: string;
    sandboxId: string;
    jobId: string;
    resultPath: string;
  }): Promise<JobResult | null>;

  streamLogs(input: StreamLogsInput): AsyncIterable<LogChunk>;

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
