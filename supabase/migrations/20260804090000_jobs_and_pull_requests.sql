-- M6–M9: detached Claude jobs and pull-request publishing.
--
-- Detached jobs need a provider-owned completion record and a process identity
-- alongside the log they already had. Publishing records exactly one pull
-- request per workspace so retries are idempotent.
-- ---------------------------------------------------------------------------

-- jobs: provider-owned result path + detached process handle
-- ---------------------------------------------------------------------------

alter table jobs
  add column if not exists result_path text,
  add column if not exists execution_handle text;

-- ---------------------------------------------------------------------------
-- pull_requests: one Runtime-created pull request per workspace
-- ---------------------------------------------------------------------------

create table pull_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,

  github_number integer not null,
  url text not null,
  title text not null,
  base_branch text not null,
  head_branch text not null,

  created_at timestamptz not null default now(),

  -- Publishing is idempotent: a workspace maps to at most one pull request.
  -- This unique constraint backs `getWorkspacePullRequest`'s single-row read.
  constraint pull_requests_one_per_workspace unique (workspace_id),

  -- A pull request cannot point at a workspace owned by another Runtime user.
  -- Mirrors the composite ownership foreign key used by workspaces and jobs.
  constraint pull_requests_owner_workspace_fkey
    foreign key (owner_id, workspace_id)
    references workspaces (owner_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Row level security: a row is visible only to its owner.
-- ---------------------------------------------------------------------------

alter table pull_requests enable row level security;

create policy pull_requests_owner_all on pull_requests
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
