import { createSupabaseServerClient } from "@/lib/supabase/server";
import { toJob, toProject, toWorkspace } from "@/lib/db/mappers";
import type {
  Job,
  JobStatus,
  Project,
  ProvisionPhase,
  Workspace,
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
  provider: string;
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
  prompt: string;
  linearIssueId?: string | null;
}): Promise<Job> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
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
