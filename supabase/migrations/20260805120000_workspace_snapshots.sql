-- Phase 1 · Milestone 4 — Workspace Snapshot foundations.
--
-- A Workspace Snapshot is Runtime's durable persistence abstraction: a
-- first-class, immutable object addressed entirely through its manifest. The
-- canonical bytes live in object storage (Supabase Storage); the manifest.json
-- is written LAST, so its presence marks the Snapshot complete.
--
-- This table is a DERIVED, owner-scoped index over those storage objects — it
-- exists to list snapshots cheaply and to carry the retention `policy`. It is
-- NOT the source of truth: `manifest` is a cached copy of the canonical
-- manifest.json, and consumers that need truth read storage. Keeping the row
-- small (pointers, checksums, sizes, counts — never blobs) keeps listing fast.
--
-- Scope note: this is an M4 *foundation*. The archive/replay/restore flows that
-- populate and consume it are built on top of M3's Workspace Session and are
-- intentionally NOT part of this migration. This does NOT touch `workspace_status`.
-- ---------------------------------------------------------------------------

-- Retention intent carried by every Snapshot so we never implicitly commit to
-- infinite storage. v0 only ever writes 'manual_only'; the sweep that honors the
-- other values is out of scope. `retention_days` gives 'delete_after_n_days' a
-- concrete horizon so the enum value is meaningful rather than half-defined.
create type archive_policy as enum (
  'keep_forever',
  'delete_after_n_days',
  'manual_only'
);

create table workspace_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,

  -- Logical time the Snapshot was produced (mirrors manifest.archivedAt). Used
  -- for newest-first listing; distinct from created_at (the row insert time).
  archived_at timestamptz not null,

  -- Storage pointer: the owner-scoped prefix the Snapshot's artifacts live under
  -- (e.g. 'archives/{owner_id}/{workspace_id}/{archivedAt}/'). The manifest is
  -- at `{storage_path}manifest.json`. The bucket is a server-side constant.
  storage_path text not null,

  -- Cached copy of the canonical manifest.json for cheap queries/listing. Derived,
  -- not authoritative. Pointer-only by contract: large payloads (conversation,
  -- cast, tree, summary.filesTouched) are storage artifacts, never embedded here.
  manifest jsonb not null,

  -- Retention metadata. The one mutable field on an otherwise immutable Snapshot.
  policy archive_policy not null default 'manual_only',
  retention_days integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite ownership target (mirrors jobs -> workspaces, pull_requests ->
  -- workspaces). Destroying a workspace removes its Snapshots (the plan's
  -- "destroy an archived workspace removes its Snapshot").
  constraint workspace_snapshots_owner_workspace_fkey
    foreign key (owner_id, workspace_id)
    references workspaces (owner_id, id) on delete cascade,

  -- 'delete_after_n_days' is meaningless without an N; enforce it explicitly.
  constraint workspace_snapshots_retention_days_ck
    check (policy <> 'delete_after_n_days' or retention_days is not null)
);

-- Serves the primary query — "Snapshots for this workspace, newest first" — and
-- the owner-scoped RLS predicate. Mirrors the (owner_id, ...) index convention.
create index workspace_snapshots_owner_workspace_archived_idx
  on workspace_snapshots (owner_id, workspace_id, archived_at desc);

create trigger workspace_snapshots_set_updated_at
  before update on workspace_snapshots
  for each row execute function set_updated_at();

alter table workspace_snapshots enable row level security;

create policy workspace_snapshots_owner_all on workspace_snapshots
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
