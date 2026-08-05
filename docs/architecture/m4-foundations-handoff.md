# M4 Foundations Handoff — runs in parallel with M3

Handoff for the agent building **M4 foundations only**, concurrently with the M3
agent. Read the frozen design first: [`m4-plan.md`](./m4-plan.md) (the Workspace
Snapshot abstraction). This note is about **scope + boundaries**, not re-design.

## Scope

> **Build the M4 foundations. Do NOT build the archive / replay / restore flows.**
> The flows consume M3's Workspace Session, conversation `/events`, and Workspace
> Summary — all in flight. Foundations are independent and de-risk M4.

**In scope (3 workstreams, mostly new files):**
1. **PTY cast-capture spike + recorder** (Go agent).
2. **Storage plumbing** (Supabase Storage: private bucket + signed-URL helpers).
3. **Snapshot foundations** (manifest zod schema + `workspace_snapshots` table).

**Out of scope (blocked on M3 — do not start):** the `archive`/`replay`/`restore`
orchestration, the lifecycle `archive` action, the `archived/archiving/restoring`
`workspace_status` values, the Workspace Summary *implementation* (M3 owns it), and
anything under `app/workspaces/**`, `components/workspace-studio*`, the browser
session endpoint, or the agent `/events` route.

## Parallel-work contract (read before editing)

The M3 agent is editing the UI, the Session/Summary surfaces, and `runtime-agent`.
To avoid collisions:

**You OWN (new files — safe):**
- `runtime-agent/internal/cast/**` (new package) + a cast-capture spike.
- `lib/runtime/storage/**` (new) — Supabase Storage client + signed URLs.
- `lib/runtime/snapshot/**` (new) — manifest schema + snapshot types.
- A **new migration** `supabase/migrations/<ts>_workspace_snapshots.sql` (append-only).
- `test/**` for the above (new test files).

**DO NOT TOUCH (M3 territory):**
- `app/workspaces/**`, `components/workspace-studio*`
- `app/api/workspaces/[id]/**` and `app/api/projects/[id]/workspaces/route.ts`
- `runtime-agent/internal/server/server.go` (M3 adds `/events`) — except the ONE
  coordinated hook below.
- `lib/runtime/agent-protocol.ts` (frozen; M3 may extend it).
- **`workspace_status`** enum anywhere (`database.types.ts`, `types.ts`, migrations).
  You don't need it — snapshots are a separate table.

**Coordinate (shared, additive-only):**
- `lib/supabase/database.types.ts` / `lib/db/mappers.ts` — add ONLY the new
  `workspace_snapshots` table types/mapper, as a new appended block. Don't edit
  existing tables. Additive edits to distinct regions merge cleanly.
- `runtime-agent/internal/ptyx/session.go` — cast capture needs one tee hook in the
  PTY read loop. Keep it to a **single minimal call** into your `cast` package (or
  defer integration and land the recorder standalone first). Flag it for the M3
  agent so it's not a surprise at merge.

## Frozen contracts you can rely on

From [`m4-plan.md`](./m4-plan.md) — these are decided; build to them:
- **Manifest** is the contract; nothing enumerates storage. Implement the manifest
  shape (version, workspaceId, runtime/claude versions, sessionId, pointers,
  checksums, sizes, timestamps, lastCommit, lastMessage, tokenUsage, changedFiles)
  as a zod schema in `lib/runtime/snapshot/`.
- **Tree is an interface** (`manifest.tree.kind`), v0 impl `git-bundle+patch`.
- **Storage** = Supabase Storage, private + owner-scoped, signed URLs.
- **WorkspaceSummary** shape is frozen in `m4-plan.md` — import/mirror the *type*
  only; the M3 agent implements its production.

## Workstreams

### 1. PTY cast-capture spike + recorder (Go)
- Prove the agent can record a PTY session as **asciinema v2** and that it replays
  faithfully (a spike + short note, Phase-0 style).
- Land a `cast` package that writes a valid `.cast`; recording starts at session
  start (invariant: independent of any browser connection).
- Integration hook into `ptyx/session.go` = one coordinated line (see contract).
- **Acceptance:** record a scripted session → replay reproduces the terminal.

### 2. Storage plumbing (TS)
- Private, owner-scoped Supabase Storage bucket for snapshots.
- Helpers: signed **upload** URL (for the agent to push artifacts) + signed
  **download** URL (for replay/restore). Path scheme per `m4-plan.md`
  (`archives/{owner_id}/{workspace_id}/{archivedAt}/…`).
- **Acceptance:** unit tests for URL construction/scoping; a round-trip test
  (upload a blob via signed URL, read it back) against the real bucket.

### 3. Snapshot foundations (TS + migration)
- `manifest` zod schema + `WorkspaceSnapshot` domain types in `lib/runtime/snapshot/`.
- `workspace_snapshots` table (owner-scoped, RLS mirroring existing tables;
  `workspace_id` FK; `manifest jsonb`; `policy` for retention — `keep_forever` /
  `delete_after_n_days` / `manual_only`, default `manual_only`; storage pointer;
  timestamps). Add the new table to `database.types.ts` + a `toWorkspaceSnapshot`
  mapper (appended blocks only). **Do not touch `workspace_status`.**
- **Acceptance:** `pnpm check` green; migration applies; manifest schema round-trips
  a golden fixture.

## Verify
- `pnpm check` (typecheck + lint + tests) for TS.
- `cd runtime-agent && go build ./... && go vet ./... && go test ./...` for Go.
- Keep everything behind the new files/table; nothing should change existing
  behavior (the flows that wire this in come after M3).

## When M3 lands
The flows (archive → produce Snapshot; replay from manifest; restore with
verification) get built on top of these foundations + M3's Session/Summary/events,
per [`m4-plan.md`](./m4-plan.md). Not before.

## Pointers
- Frozen M4 design: [`m4-plan.md`](./m4-plan.md)
- M3 surface (what you must not touch / what you'll build on later): [`m3-handoff.md`](./m3-handoff.md)
- Protocol / agent: [`protocol.md`](./protocol.md), [`runtime-agent.md`](./runtime-agent.md)
- Progress: [`PROGRESS.md`](./PROGRESS.md)
