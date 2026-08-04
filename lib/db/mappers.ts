import type { Database } from "@/lib/supabase/database.types";
import type {
  Job,
  Project,
  RuntimeComputer,
  Workspace,
  WorkspacePullRequest,
} from "@/lib/runtime/types";

type Tables = Database["public"]["Tables"];

/** DB row -> domain object. Keeps snake_case confined to the db layer. */
export function toProject(row: Tables["projects"]["Row"]): Project {
  return {
    id: row.id,
    githubRepoId: row.github_repo_id,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    private: row.is_private,
    language: row.language,
    description: row.description,
    htmlUrl: row.html_url ?? `https://github.com/${row.full_name}`,
    pushedAt: row.pushed_at,
    linearIssueIds: (row.linear_issues ?? []).map((i) => i.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toWorkspace(row: Tables["workspaces"]["Row"]): Workspace {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider === "modal" ? "modal" : "local",
    status: row.status,
    phase: row.phase,
    branch: row.branch,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path ?? "",
    sandboxId: row.sandbox_id,
    volumeName: row.volume_name,
    computerId: row.computer_id,
    tmuxSession: row.tmux_session,
    agentWorkspaceId: row.agent_workspace_id,
    lastActiveAt: row.last_active_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * DB row -> domain object. `agent_secret` is intentionally omitted: it is
 * server-only and must never reach the domain/UI layer. Read it directly from
 * the row when minting or verifying Runtime tokens.
 */
export function toRuntimeComputer(
  row: Tables["runtime_computers"]["Row"],
): RuntimeComputer {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    imageVersion: row.image_version,
    daytonaSandboxId: row.daytona_sandbox_id,
    agentBaseUrl: row.agent_base_url,
    errorMessage: row.error_message,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toJob(row: Tables["jobs"]["Row"]): Job {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agent: row.agent,
    status: row.status,
    prompt: row.prompt,
    logPath: row.log_path ?? "",
    resultPath: row.result_path ?? "",
    executionHandle: row.execution_handle,
    logBytes: row.log_bytes,
    exitCode: row.exit_code,
    sessionId: row.session_id,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export function toWorkspacePullRequest(
  row: Tables["pull_requests"]["Row"],
): WorkspacePullRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    number: row.github_number,
    url: row.url,
    title: row.title,
    baseBranch: row.base_branch,
    headBranch: row.head_branch,
    createdAt: row.created_at,
  };
}
