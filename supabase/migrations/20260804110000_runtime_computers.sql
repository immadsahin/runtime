-- Phase 1 · Milestone 1 — Foundations.
--
-- Runtime Computers: one long-lived Daytona Ubuntu box per Project, built from
-- a frozen, versioned image (runtime-computer-v1). Provisioned lazily on the
-- first workspace and kept warm (Phase 0 "always-on" decision). Workspaces run
-- inside it as tmux sessions and reference it here.
-- ---------------------------------------------------------------------------

create type runtime_computer_status as enum (
  'provisioning',
  'ready',
  'error',
  'stopped'
);

create table runtime_computers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null,

  status runtime_computer_status not null default 'provisioning',

  -- Frozen image tag this box was built from (e.g. 'v1'). Enables
  -- reproducibility and per-image upgrade paths.
  image_version text not null default 'v1',

  -- Daytona sandbox id; null until compute is provisioned.
  daytona_sandbox_id text,

  -- Base of the Daytona preview URL the runtime-agent is reachable at.
  agent_base_url text,

  -- Per-computer secret used to mint/verify Runtime tokens between the Next
  -- control plane and the agent. Server-only: RLS keeps it owner-scoped and it
  -- is never selected into any browser-facing payload.
  agent_secret text,

  error_message text,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint runtime_computers_owner_project_fkey
    foreign key (owner_id, project_id)
    references projects (owner_id, id) on delete cascade,

  -- Composite ownership target for workspaces.computer_id (mirrors the pattern
  -- used by workspaces -> projects and jobs -> workspaces).
  constraint runtime_computers_owner_id_unique unique (owner_id, id),

  -- MVP invariant: one Runtime Computer per Project. Drop this constraint to
  -- evolve to many-per-project (warm pools) without touching the model.
  constraint runtime_computers_project_unique unique (project_id)
);

create index runtime_computers_owner_status_idx
  on runtime_computers (owner_id, status);

create trigger runtime_computers_set_updated_at
  before update on runtime_computers
  for each row execute function set_updated_at();

alter table runtime_computers enable row level security;

create policy runtime_computers_owner_all on runtime_computers
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- workspaces: attach to a Runtime Computer and record agent-side identity.
-- ---------------------------------------------------------------------------

alter table workspaces
  add column computer_id uuid,
  add column tmux_session text,
  add column agent_workspace_id text;

-- Preserve workspace rows (and their archive metadata) if the computer is
-- destroyed; the app treats a null computer_id as "needs a fresh computer".
alter table workspaces
  add constraint workspaces_computer_fkey
    foreign key (owner_id, computer_id)
    references runtime_computers (owner_id, id) on delete set null;

create index workspaces_computer_idx on workspaces (computer_id);
