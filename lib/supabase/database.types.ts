/**
 * Database types for the Runtime schema.
 *
 * Hand-maintained to match supabase/migrations/*.sql. Regenerate with:
 *   pnpm supabase gen types typescript --project-id <ref> > lib/supabase/database.types.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type WorkspaceStatusDb =
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

export type ProvisionPhaseDb =
  | "allocate"
  | "clone"
  | "worktree"
  | "secrets"
  | "install"
  | "health_check"
  | "claude_ready";

export type JobStatusDb =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobAgentDb = "claude" | "codex";

export type RuntimeComputerStatusDb =
  | "provisioning"
  | "ready"
  | "error"
  | "stopped";

// M4 — Workspace Snapshot foundations.
export type ArchivePolicyDb =
  | "keep_forever"
  | "delete_after_n_days"
  | "manual_only";

export type LinearIssueRef = {
  id: string;
  identifier: string;
  title: string;
  url: string;
};

type ProjectRow = {
  id: string;
  owner_id: string;
  github_repo_id: number;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  is_private: boolean;
  language: string | null;
  description: string | null;
  html_url: string | null;
  pushed_at: string | null;
  linear_issues: LinearIssueRef[];
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  owner_id: string;
  project_id: string;
  status: WorkspaceStatusDb;
  phase: ProvisionPhaseDb | null;
  branch: string;
  base_branch: string;
  worktree_path: string | null;
  sandbox_id: string | null;
  volume_name: string | null;
  provider: string;
  install_command: string | null;
  error_message: string | null;
  computer_id: string | null;
  tmux_session: string | null;
  agent_workspace_id: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

type RuntimeComputerRow = {
  id: string;
  owner_id: string;
  project_id: string;
  compute_provider: "daytona" | "e2b";
  placement_key: string;
  topology: "shared" | "isolated";
  status: RuntimeComputerStatusDb;
  image_version: string;
  daytona_sandbox_id: string | null;
  provider_computer_id: string | null;
  agent_base_url: string | null;
  agent_secret: string | null;
  provision_timings: Json | null;
  error_message: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  agent: JobAgentDb;
  status: JobStatusDb;
  prompt: string;
  log_path: string | null;
  result_path: string | null;
  execution_handle: string | null;
  log_bytes: number;
  exit_code: number | null;
  session_id: string | null;
  cost_usd: number | null;
  linear_issue_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

type PullRequestRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  github_number: number;
  url: string;
  title: string;
  base_branch: string;
  head_branch: string;
  created_at: string;
};

// M4 — the DERIVED, owner-scoped index over Snapshot storage objects. `manifest`
// is a cached copy of the canonical manifest.json (jsonb, typed as Json here).
type WorkspaceSnapshotRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  archived_at: string;
  storage_path: string;
  manifest: Json;
  policy: ArchivePolicyDb;
  retention_days: number | null;
  created_at: string;
  updated_at: string;
};

/** Columns the client may supply on insert (defaults fill the rest). */
type Insert<Row, Required extends keyof Row> = Pick<Row, Required> &
  Partial<Omit<Row, Required | "created_at" | "updated_at">>;

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: ProjectRow;
        Insert: Insert<
          ProjectRow,
          "owner_id" | "github_repo_id" | "full_name" | "owner" | "name"
        >;
        Update: Partial<ProjectRow>;
        Relationships: [];
      };
      workspaces: {
        Row: WorkspaceRow;
        Insert: Insert<WorkspaceRow, "owner_id" | "project_id" | "branch">;
        Update: Partial<WorkspaceRow>;
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_project_fkey";
            columns: ["owner_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["owner_id", "id"];
          },
          {
            foreignKeyName: "workspaces_computer_fkey";
            columns: ["owner_id", "computer_id"];
            isOneToOne: false;
            referencedRelation: "runtime_computers";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      runtime_computers: {
        Row: RuntimeComputerRow;
        Insert: Insert<RuntimeComputerRow, "owner_id" | "project_id">;
        Update: Partial<RuntimeComputerRow>;
        Relationships: [
          {
            foreignKeyName: "runtime_computers_owner_project_fkey";
            columns: ["owner_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      jobs: {
        Row: JobRow;
        Insert: Insert<JobRow, "owner_id" | "workspace_id" | "prompt">;
        Update: Partial<JobRow>;
        Relationships: [
          {
            foreignKeyName: "jobs_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      pull_requests: {
        Row: PullRequestRow;
        Insert: Insert<
          PullRequestRow,
          "owner_id" | "workspace_id" | "github_number" | "url" | "title" | "base_branch" | "head_branch"
        >;
        Update: Partial<PullRequestRow>;
        Relationships: [
          {
            foreignKeyName: "pull_requests_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
      workspace_snapshots: {
        Row: WorkspaceSnapshotRow;
        Insert: Insert<
          WorkspaceSnapshotRow,
          "owner_id" | "workspace_id" | "archived_at" | "storage_path" | "manifest"
        >;
        Update: Partial<WorkspaceSnapshotRow>;
        Relationships: [
          {
            foreignKeyName: "workspace_snapshots_owner_workspace_fkey";
            columns: ["owner_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["owner_id", "id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      claim_runtime_computer: {
        Args: {
          requested_project_id: string;
          requested_placement_key?: string;
          requested_compute_provider?: string;
          requested_topology?: "shared" | "isolated";
          requested_agent_secret: string;
          requested_image_version?: string;
        };
        Returns: Array<{
          runtime_computer_id: string;
          should_provision: boolean;
        }>;
      };
    };
    Enums: {
      workspace_status: WorkspaceStatusDb;
      provision_phase: ProvisionPhaseDb;
      job_status: JobStatusDb;
      runtime_computer_status: RuntimeComputerStatusDb;
      archive_policy: ArchivePolicyDb;
    };
    CompositeTypes: Record<never, never>;
  };
};
