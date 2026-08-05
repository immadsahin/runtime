import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  toJob,
  toProject,
  toRuntimeComputer,
  toWorkspace,
  toWorkspacePullRequest,
  toWorkspaceSnapshot,
} from "@/lib/db/mappers";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type {
  ArchivePolicy,
  WorkspaceSnapshot,
} from "@/lib/runtime/snapshot/types";
import type {
  Job,
  JobAgent,
  JobStatus,
  Project,
  ProviderName,
  ProvisionPhase,
  ProvisionTimings,
  RuntimeComputer,
  RuntimeComputerStatus,
  Workspace,
  WorkspacePullRequest,
  WorkspaceStatus,
} from "@/lib/runtime/types";

/**
 * Data access for the three tables. RLS already restricts rows to the owner,
 * so these helpers never filter by owner_id on read.
 */

// --- projects --------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .is("hidden_at", null)
    .order("pushed_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return (data ?? []).map(toProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toProject(data) : null;
}

/** Upsert the repositories returned by GitHub, keyed on (owner, repo id). */
export async function upsertProjects(
  ownerId: string,
  repos: Array<{
    githubRepoId: number;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
    language: string | null;
    description: string | null;
    htmlUrl: string;
    pushedAt: string | null;
  }>,
): Promise<number> {
  if (repos.length === 0) return 0;

  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("projects")
    .upsert(
      repos.map((r) => ({
        owner_id: ownerId,
        github_repo_id: r.githubRepoId,
        full_name: r.fullName,
        owner: r.owner,
        name: r.name,
        default_branch: r.defaultBranch,
        is_private: r.private,
        language: r.language,
        description: r.description,
        html_url: r.htmlUrl,
        pushed_at: r.pushedAt,
      })),
      { onConflict: "owner_id,github_repo_id", count: "exact" },
    );

  if (error) throw error;
  return count ?? repos.length;
}

// --- workspaces ------------------------------------------------------------

export async function listWorkspaces(
  projectId?: string,
): Promise<Workspace[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("workspaces")
    .select("*")
    .neq("status", "destroyed")
    .order("last_active_at", { ascending: false, nullsFirst: false });

  if (projectId) query = query.eq("project_id", projectId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(toWorkspace);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

export async function createWorkspaceRow(input: {
  ownerId: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  provider: ProviderName;
}): Promise<Workspace> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .insert({
      owner_id: input.ownerId,
      project_id: input.projectId,
      branch: input.branch,
      base_branch: input.baseBranch,
      provider: input.provider,
      status: "creating",
    })
    .select("*")
    .single();

  if (error) throw error;
  return toWorkspace(data);
}

export async function updateWorkspace(
  id: string,
  patch: {
    status?: WorkspaceStatus;
    phase?: ProvisionPhase | null;
    sandboxId?: string | null;
    volumeName?: string | null;
    computerId?: string | null;
    tmuxSession?: string | null;
    agentWorkspaceId?: string | null;
    worktreePath?: string | null;
    errorMessage?: string | null;
    touchActive?: boolean;
  },
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("workspaces")
    .update({
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.phase !== undefined && { phase: patch.phase }),
      ...(patch.sandboxId !== undefined && { sandbox_id: patch.sandboxId }),
      ...(patch.volumeName !== undefined && { volume_name: patch.volumeName }),
      ...(patch.computerId !== undefined && { computer_id: patch.computerId }),
      ...(patch.tmuxSession !== undefined && { tmux_session: patch.tmuxSession }),
      ...(patch.agentWorkspaceId !== undefined && {
        agent_workspace_id: patch.agentWorkspaceId,
      }),
      ...(patch.worktreePath !== undefined && {
        worktree_path: patch.worktreePath,
      }),
      ...(patch.errorMessage !== undefined && {
        error_message: patch.errorMessage,
      }),
      ...(patch.touchActive && { last_active_at: new Date().toISOString() }),
    })
    .eq("id", id);

  if (error) throw error;
}

/**
 * Move a workspace only if it remains in an expected state. Lifecycle actions
 * use this optimistic transition so a second tab cannot start a duplicate
 * suspend, resume, or destroy operation against the same provider resource.
 */
export async function transitionWorkspace(input: {
  id: string;
  from: WorkspaceStatus[];
  patch: {
    status: WorkspaceStatus;
    phase?: ProvisionPhase | null;
    sandboxId?: string | null;
    volumeName?: string | null;
    worktreePath?: string | null;
    errorMessage?: string | null;
    touchActive?: boolean;
  };
}): Promise<Workspace | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .update({
      status: input.patch.status,
      ...(input.patch.phase !== undefined && { phase: input.patch.phase }),
      ...(input.patch.sandboxId !== undefined && {
        sandbox_id: input.patch.sandboxId,
      }),
      ...(input.patch.volumeName !== undefined && {
        volume_name: input.patch.volumeName,
      }),
      ...(input.patch.worktreePath !== undefined && {
        worktree_path: input.patch.worktreePath,
      }),
      ...(input.patch.errorMessage !== undefined && {
        error_message: input.patch.errorMessage,
      }),
      ...(input.patch.touchActive && { last_active_at: new Date().toISOString() }),
    })
    .eq("id", input.id)
    .in("status", input.from)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

// --- runtime computers -----------------------------------------------------

/** The one Runtime Computer for a project, if it has been provisioned. */
export async function getRuntimeComputerByProject(
  projectId: string,
): Promise<RuntimeComputer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("*")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) throw error;
  return data ? toRuntimeComputer(data) : null;
}

/**
 * Claim the single Runtime Computer slot for a project. The
 * `unique (project_id)` constraint makes this the concurrency gate for lazy
 * provisioning: two "New Workspace" clicks race here and exactly one insert
 * wins. The loser gets a unique-violation, catches it, and reads the existing
 * row via {@link getRuntimeComputerByProject}.
 */
export async function createRuntimeComputer(input: {
  ownerId: string;
  projectId: string;
  agentSecret: string;
  imageVersion?: string;
}): Promise<RuntimeComputer> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .insert({
      owner_id: input.ownerId,
      project_id: input.projectId,
      agent_secret: input.agentSecret,
      status: "provisioning",
      ...(input.imageVersion && { image_version: input.imageVersion }),
    })
    .select("*")
    .single();

  if (error) throw error;
  return toRuntimeComputer(data);
}

/**
 * Atomically claim the per-project Runtime Computer slot. The SQL function
 * takes a transaction-scoped advisory lock before reading/inserting, while the
 * `unique (project_id)` constraint remains the durable backstop.
 */
export async function claimRuntimeComputer(input: {
  projectId: string;
  agentSecret: string;
}): Promise<{ computer: RuntimeComputer; shouldProvision: boolean }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_runtime_computer", {
    requested_project_id: input.projectId,
    requested_agent_secret: input.agentSecret,
  });

  if (error) throw error;
  const claim = data?.[0];
  if (!claim || data.length !== 1) {
    throw new Error("Runtime Computer claim returned an invalid result.");
  }
  const computer = await getRuntimeComputerByProject(input.projectId);
  if (!computer || computer.id !== claim.runtime_computer_id) {
    throw new Error("Runtime Computer claim was not persisted.");
  }
  return { computer, shouldProvision: claim.should_provision };
}

export async function updateRuntimeComputer(
  id: string,
  patch: {
    status?: RuntimeComputerStatus;
    daytonaSandboxId?: string | null;
    agentBaseUrl?: string | null;
    provisionTimings?: ProvisionTimings | null;
    errorMessage?: string | null;
    touchActive?: boolean;
  },
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("runtime_computers")
    .update({
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.daytonaSandboxId !== undefined && {
        daytona_sandbox_id: patch.daytonaSandboxId,
      }),
      ...(patch.agentBaseUrl !== undefined && {
        agent_base_url: patch.agentBaseUrl,
      }),
      ...(patch.provisionTimings !== undefined && {
        provision_timings: patch.provisionTimings,
      }),
      ...(patch.errorMessage !== undefined && {
        error_message: patch.errorMessage,
      }),
      ...(patch.touchActive && { last_active_at: new Date().toISOString() }),
    })
    .eq("id", id);

  if (error) throw error;
}

/**
 * Mark a ready Runtime Computer stopped only if it still refers to the exact
 * Daytona sandbox we just found unavailable. The compare-and-set guards the
 * lazy-provisioning claim: two simultaneous New Workspace requests can both
 * observe a dead box, but only one is allowed to make it retryable.
 */
export async function markRuntimeComputerStoppedIfReady(
  id: string,
  daytonaSandboxId: string,
): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .update({
      status: "stopped",
      error_message: "Runtime Computer is no longer available and will be reprovisioned.",
    })
    .eq("id", id)
    .eq("status", "ready")
    .eq("daytona_sandbox_id", daytonaSandboxId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

/**
 * Read the server-only per-computer secret used to mint Runtime tokens. Kept
 * out of the domain object (see {@link toRuntimeComputer}) so it never rides
 * along into a browser-facing payload; callers ask for it explicitly.
 */
export async function readRuntimeComputerSecret(
  id: string,
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runtime_computers")
    .select("agent_secret")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data?.agent_secret ?? null;
}

// --- jobs ------------------------------------------------------------------

export async function listJobs(workspaceId: string): Promise<Job[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toJob);
}

export async function getJob(id: string): Promise<Job | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toJob(data) : null;
}

export async function createJobRow(input: {
  ownerId: string;
  workspaceId: string;
  agent: JobAgent;
  prompt: string;
  linearIssueId?: string | null;
}): Promise<Job> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      agent: input.agent,
      prompt: input.prompt,
      linear_issue_id: input.linearIssueId ?? null,
      status: "queued",
    })
    .select("*")
    .single();

  if (error) throw error;
  return toJob(data);
}

export async function updateJob(
  id: string,
  patch: {
    status?: JobStatus;
    logPath?: string | null;
    resultPath?: string | null;
    executionHandle?: string | null;
    logBytes?: number;
    exitCode?: number | null;
    sessionId?: string | null;
    costUsd?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  },
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("jobs")
    .update({
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.logPath !== undefined && { log_path: patch.logPath }),
      ...(patch.resultPath !== undefined && { result_path: patch.resultPath }),
      ...(patch.executionHandle !== undefined && {
        execution_handle: patch.executionHandle,
      }),
      ...(patch.logBytes !== undefined && { log_bytes: patch.logBytes }),
      ...(patch.exitCode !== undefined && { exit_code: patch.exitCode }),
      ...(patch.sessionId !== undefined && { session_id: patch.sessionId }),
      ...(patch.costUsd !== undefined && { cost_usd: patch.costUsd }),
      ...(patch.startedAt !== undefined && { started_at: patch.startedAt }),
      ...(patch.finishedAt !== undefined && { finished_at: patch.finishedAt }),
    })
    .eq("id", id);

  if (error) throw error;
}

/** Atomically claim or complete a job only while it is in an expected state. */
export async function transitionJob(input: {
  id: string;
  from: JobStatus[];
  patch: {
    status: JobStatus;
    logPath?: string | null;
    resultPath?: string | null;
    executionHandle?: string | null;
    logBytes?: number;
    exitCode?: number | null;
    sessionId?: string | null;
    costUsd?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  };
}): Promise<Job | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: input.patch.status,
      ...(input.patch.logPath !== undefined && { log_path: input.patch.logPath }),
      ...(input.patch.resultPath !== undefined && { result_path: input.patch.resultPath }),
      ...(input.patch.executionHandle !== undefined && {
        execution_handle: input.patch.executionHandle,
      }),
      ...(input.patch.logBytes !== undefined && { log_bytes: input.patch.logBytes }),
      ...(input.patch.exitCode !== undefined && { exit_code: input.patch.exitCode }),
      ...(input.patch.sessionId !== undefined && { session_id: input.patch.sessionId }),
      ...(input.patch.costUsd !== undefined && { cost_usd: input.patch.costUsd }),
      ...(input.patch.startedAt !== undefined && { started_at: input.patch.startedAt }),
      ...(input.patch.finishedAt !== undefined && { finished_at: input.patch.finishedAt }),
    })
    .eq("id", input.id)
    .in("status", input.from)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? toJob(data) : null;
}

export async function getWorkspacePullRequest(
  workspaceId: string,
): Promise<WorkspacePullRequest | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pull_requests")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkspacePullRequest(data) : null;
}

export async function createWorkspacePullRequest(input: {
  ownerId: string;
  workspaceId: string;
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
}): Promise<WorkspacePullRequest> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pull_requests")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      github_number: input.number,
      url: input.url,
      title: input.title,
      base_branch: input.baseBranch,
      head_branch: input.headBranch,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toWorkspacePullRequest(data);
}

// --- snapshots -------------------------------------------------------------

/**
 * Insert the DERIVED index row for a Workspace Snapshot after the agent has
 * uploaded its artifacts (manifest last). The canonical Snapshot lives in
 * storage; this row caches the manifest for cheap listing and carries the
 * retention `policy` (v0 always `manual_only`). `archivedAt` and `storagePath`
 * must be the same values Next used to mint the upload URLs, so the row and the
 * stored objects agree.
 */
/** A workspace's Snapshots, newest first (the Replay picker's list). */
export async function listWorkspaceSnapshots(
  workspaceId: string,
): Promise<WorkspaceSnapshot[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("archived_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toWorkspaceSnapshot);
}

/** One Snapshot by id, or null. RLS confines the read to the owner. */
export async function getWorkspaceSnapshot(
  id: string,
): Promise<WorkspaceSnapshot | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_snapshots")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkspaceSnapshot(data) : null;
}

export async function createWorkspaceSnapshot(input: {
  ownerId: string;
  workspaceId: string;
  archivedAt: string;
  storagePath: string;
  manifest: SnapshotManifest;
  policy?: ArchivePolicy;
  retentionDays?: number | null;
}): Promise<WorkspaceSnapshot> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_snapshots")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      archived_at: input.archivedAt,
      storage_path: input.storagePath,
      manifest: input.manifest,
      policy: input.policy ?? "manual_only",
      retention_days: input.retentionDays ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toWorkspaceSnapshot(data);
}
