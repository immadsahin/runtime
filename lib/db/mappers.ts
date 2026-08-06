import { parseManifest } from "@/lib/runtime/snapshot/manifest";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";
import type { Database } from "@/lib/supabase/database.types";
import type {
  Job,
  Project,
  ProviderName,
  ProvisionTimings,
  RuntimeComputer,
  Workspace,
  WorkspacePullRequest,
} from "@/lib/runtime/types";

type Tables = Database["public"]["Tables"];

const PROVIDERS: readonly ProviderName[] = ["local", "modal", "daytona", "e2b"];

/** Narrow the free-text `provider` column to a known backend (defaults local). */
function toProviderName(value: string): ProviderName {
  return (PROVIDERS as readonly string[]).includes(value)
    ? (value as ProviderName)
    : "local";
}

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
    provider: toProviderName(row.provider),
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

/** Defensively read the `provision_timings` jsonb into the domain shape. The
 *  column is written only by the provider, but the parser tolerates absent or
 *  malformed data rather than throwing inside a mapper. */
function toProvisionTimings(value: unknown): ProvisionTimings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.stages) || typeof record.totalMs !== "number") {
    return null;
  }
  const stages = record.stages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const stage = (entry as Record<string, unknown>).stage;
    const ms = (entry as Record<string, unknown>).ms;
    return typeof stage === "string" && typeof ms === "number"
      ? [{ stage: stage as ProvisionTimings["stages"][number]["stage"], ms }]
      : [];
  });
  return { stages, totalMs: record.totalMs };
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
    provider: row.compute_provider === "e2b" ? "e2b" : "daytona",
    placementKey: row.placement_key ?? `project:${row.project_id}`,
    topology: row.topology ?? "shared",
    status: row.status,
    imageVersion: row.image_version,
    providerComputerId: row.provider_computer_id ?? row.daytona_sandbox_id,
    daytonaSandboxId: row.provider_computer_id ?? row.daytona_sandbox_id,
    agentBaseUrl: row.agent_base_url,
    provisionTimings: toProvisionTimings(row.provision_timings),
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

/**
 * DB row -> domain object. The `manifest` jsonb is a derived cache of the
 * canonical manifest.json; parse it through the schema at this boundary so a
 * malformed cached copy fails loudly here rather than downstream.
 */
export function toWorkspaceSnapshot(
  row: Tables["workspace_snapshots"]["Row"],
): WorkspaceSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    archivedAt: row.archived_at,
    storagePath: row.storage_path,
    manifest: parseManifest(row.manifest),
    policy: row.policy,
    retentionDays: row.retention_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
