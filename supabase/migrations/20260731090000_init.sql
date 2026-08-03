-- Runtime v0 initial schema.
--
-- Three tables, per the spec: projects, workspaces, jobs.
--
-- Runtime is deliberately single-user, but rows still carry `owner_id` so that
-- RLS can be expressed as "the row belongs to the signed-in user". That keeps
-- the anon key safe to use from the browser without inventing a permission
-- system.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums (mirror the TypeScript unions in lib/runtime/types.ts)
-- ---------------------------------------------------------------------------

create type workspace_status as enum (
  'creating',
  'provisioning',
  'ready',
  'idle',
  'resuming',
  'suspended',
  'destroyed',
  'failed'
);

create type provision_phase as enum (
  'allocate',
  'clone',
  'worktree',
  'secrets',
  'install',
  'health_check',
  'claude_ready'
);

create type job_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

-- ---------------------------------------------------------------------------
-- projects: one row per GitHub repository the owner can access
-- ---------------------------------------------------------------------------

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,

  github_repo_id bigint not null,
  full_name text not null,
  owner text not null,
  name text not null,
  default_branch text not null default 'main',
  is_private boolean not null default true,
  language text,
  description text,
  html_url text,
  pushed_at timestamptz,

  -- Linear issues are attached to existing projects; Runtime never creates
  -- standalone projects for them. Shape: [{ id, identifier, title, url }]
  linear_issues jsonb not null default '[]'::jsonb,

  -- Set when the owner archives a repo from the list without unsyncing it.
  hidden_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint projects_owner_repo_unique unique (owner_id, github_repo_id),
  constraint projects_owner_id_unique unique (owner_id, id)
);

create index projects_owner_pushed_idx
  on projects (owner_id, pushed_at desc nulls last);
create index projects_full_name_idx on projects (owner_id, full_name);

-- ---------------------------------------------------------------------------
-- workspaces: persistent, repository-centric execution environments
-- ---------------------------------------------------------------------------

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null,

  status workspace_status not null default 'creating',
  phase provision_phase,

  branch text not null,
  base_branch text not null default 'main',
  worktree_path text,

  -- Compute is disposable: Modal sandboxes have a hard 24h lifetime, so this
  -- is a *current* pointer and is null whenever the workspace is suspended.
  sandbox_id text,

  -- Durable storage (Modal Volume) that outlives any single sandbox. This is
  -- what actually makes a workspace "persistent".
  volume_name text,

  provider text not null default 'local',
  install_command text,
  error_message text,

  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A workspace cannot point at a project owned by another Runtime user.
  constraint workspaces_owner_project_fkey
    foreign key (owner_id, project_id)
    references projects (owner_id, id) on delete cascade,
  constraint workspaces_owner_id_unique unique (owner_id, id)
);

create index workspaces_owner_status_idx on workspaces (owner_id, status);
create index workspaces_project_idx on workspaces (project_id);

-- One live workspace per branch per project keeps the mental model simple and
-- prevents two agents editing the same worktree.
create unique index workspaces_active_branch_unique
  on workspaces (project_id, branch)
  where status <> 'destroyed';

-- ---------------------------------------------------------------------------
-- jobs: one Claude Code invocation inside a workspace
-- ---------------------------------------------------------------------------

create table jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,

  status job_status not null default 'queued',
  prompt text not null,

  -- Log file on durable storage, tailed by byte offset. Logs survive sandbox
  -- death, page reloads, and app redeploys.
  log_path text,
  log_bytes bigint not null default 0,

  exit_code integer,
  -- Claude Code session id, so a follow-up job can `--resume`.
  session_id text,
  cost_usd numeric(10, 4),
  -- Linear issue this job was started from, when applicable.
  linear_issue_id text,

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A job cannot point at a workspace owned by another Runtime user.
  constraint jobs_owner_workspace_fkey
    foreign key (owner_id, workspace_id)
    references workspaces (owner_id, id) on delete cascade
);

create index jobs_workspace_created_idx
  on jobs (workspace_id, created_at desc);
create index jobs_owner_status_idx on jobs (owner_id, status);

-- At most one job running per workspace: a single agent editing a single
-- worktree. Concurrency is an explicit non-goal for v0.
create unique index jobs_one_running_per_workspace
  on jobs (workspace_id)
  where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
  before update on projects
  for each row execute function set_updated_at();

create trigger workspaces_set_updated_at
  before update on workspaces
  for each row execute function set_updated_at();

create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security: a row is visible only to its owner.
-- ---------------------------------------------------------------------------

alter table projects enable row level security;
alter table workspaces enable row level security;
alter table jobs enable row level security;

create policy projects_owner_all on projects
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy workspaces_owner_all on workspaces
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy jobs_owner_all on jobs
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
