# Runtime v1 — Progress Tracker

Single source of truth for what's done and what's left. Update as milestones land.
Detail lives in [`runtime-v1-plan.md`](./runtime-v1-plan.md) and [`spike4-runtime-report.md`](./spike4-runtime-report.md).

Legend: ✅ done · 🟡 in progress · ⬜ not started

---

## Phase 0 — Validation & freeze — ✅ COMPLETE
- ✅ Spike 1 — WebSocket through Daytona signed preview URL (~270 ms warm)
- ✅ Spike 2 — PTY + tmux mechanics (attach/detach/reconnect/resize/exit/isolation)
- ✅ Spike 3 — Claude JSONL schema + incremental watcher
- ✅ Spike 4 — real Claude Code end-to-end (tools, worktrees, `--continue`, failure modes, profiling)
- ✅ Runtime Report + scheduler recommendation
- ✅ Frozen canonical image `runtime-computer-v1` (non-root)

## Milestone 1 — Foundations — ✅ COMPLETE
- ✅ pt1 · DB: `runtime_computers` table + workspace attachment (migration, types, mappers)
- ✅ pt2 · Shared `lib/runtime/git` module; both providers refactored (duplication removed)
- ✅ pt3 · Frozen `agent-protocol.ts` (zod) + golden fixtures (TS + Go drift guard)
- ✅ pt4 · `runtime-agent/` Go skeleton (auth/tmux/claude/conversation/ptyx/workspace/server)

## Milestone 2 — Replace the execution path — ✅ COMPLETE
- ✅ pt1 · Runtime tokens + typed `AgentClient` (cross-language auth verified)
- ✅ pt2 · `DaytonaRuntimeProvider` + provisioning + agent deploy — verified on a
  real box (report: [`spike-m2pt2-report.md`](./spike-m2pt2-report.md))
  - ✅ Agent-deploy decision: **1A + gzip** (upload-on-provision; 6.42→2.69 MB, 2.4×)
  - ✅ Provisioning spike: build linux binary → gzip upload → boot → `/health` (15.5 s total)
  - ✅ Provision/destroy against Daytona; bare mirror via shared git module (remote-tracking refs)
  - ✅ Wire `env.ts` `providerName()` + resolution to add `'daytona'`
  - ✅ Interactive session start via `AgentClient` (create worktree → tmux → live WS PTY)
  - ✅ Verified create → start → live PTY on a real box (auto-destroy, no orphans)
  - ✅ Provisioning instrumentation (`ProvisionTimer` → `runtime_computers.provision_timings`)
  - ✅ `runtime_computers` repository (first-class CRUD)
  - 🟡 Deferred to pt3/M3: DB-orchestrated lazy `ensureRuntimeComputer` (needs auth session)
- ✅ pt3 · Retired the SSE batch execution path
  - ✅ Deleted the job routes (`/api/workspaces/[id]/jobs` + SSE logs) and the `-p` agent runner (`agent.ts`)
  - ✅ Removed `executeJob`/`streamLogs`/`getJobResult`/`getJobPaths` from the interface + all providers
  - ✅ Deleted `settleRunningJobs`/`reconcileWorkspaceJobs` (batch reconciliation); kept `ensureLiveSandbox` for M3
  - ✅ Trimmed the job-driven UI (studio composer/JobMessage/terminal + `workspace-job-panel`); studio shell kept
  - ✅ Kept the `jobs` table + `Job` type (decision 1A) as the seed for the M3 session record
  - 🟡 Deferred to M3: move git/session ops off the `RuntimeProvider` interface; interactive session routes

## Milestone 3 — Workspace Session Experience — 🟡 IN PROGRESS
Scope + contract: [`m3-handoff.md`](./m3-handoff.md), [`session-contract.md`](./session-contract.md).
Phased execution (Option A — transport-first):
- ✅ Phase 1 — PTY transport spike proven on a live Daytona box (writer election verified; wire + agent PTY path frozen — see [`spike-m3-report.md`](./spike-m3-report.md))
- ✅ Phase 2 — Conversation `/events` SSE + seq resume + virtualized Timeline (event log frozen — see [`spike-m3-report.md`](./spike-m3-report.md))
- ✅ Phase 3 — Workspace Summary endpoint (frozen `WorkspaceSummary` shape shared with M4 — [`spike-m3-report.md`](./spike-m3-report.md))
- ✅ Phase 4 — Lazy provisioning `ensureRuntimeComputer` (unique constraint + advisory lock)
- ✅ Phase 5 — Assemble the Workspace Experience (four projections around one Session) — **API freeze after this phase**
  - One shared Daytona Runtime Computer is claimed/provisioned per project; a
    fresh workspace fetches the mirror, creates an isolated worktree, starts
    Claude, and persists its linkage.
  - The Workspace Session renders independent terminal and structured
    conversation projections, current writer/read-only role, reconnect state,
    exit state, changes, and publishing controls.
  - The agent strips control-plane variables from the Claude environment,
    redacts session credentials from PTY frames (including cross-read values),
    and binds every control request to its token's workspace.
- 🟡 Phase 6 — Acceptance test on real Daytona + `spike-m3-report.md`
  - Local/unit verification is complete, but the current sandbox has no
    `DAYTONA_API_KEY`; a provisioned Runtime Computer and authenticated
    browser session remain required for full acceptance evidence.
- ⬜ Phase 7 — Dogfood: an uninterrupted work session in Runtime without opening Conductor

## Milestone 4 — Archive / Replay / Restore — 🟡 IMPLEMENTATION COMPLETE (real-box acceptance pending)
Foundations landed (cast recorder, storage plumbing, snapshot schema + table).
Flows built as vertical slices on top: Slice 1 (Archive) → Slice 2 (Replay) →
Slice 3 (Restore) — all landed and unit/integration-green. What remains is the
`m4-plan.md` acceptance run on a real Daytona box (no `DAYTONA_API_KEY` here,
same gate as M3 Phase 6). See [`m4-plan.md`](./m4-plan.md), [`m4-foundations-handoff.md`](./m4-foundations-handoff.md).
- ✅ Foundations — PTY cast recorder (asciinema v2), Supabase Storage signed-URL
  helpers, manifest zod schema + `workspace_snapshots` table (+ bucket).
- ✅ **Slice 1 — Archive → Snapshot (produce).** State machine
  (`archiving`/`archived`/`restoring`); cast recorder wired into Start/Resume/Stop;
  agent `snapshot` package (git bundle + uncommitted patch, conversation, summary,
  sha256 checksums/sizes, manifest assembly, signed-URL upload — manifest last);
  `Service.Archive` produces + returns the manifest; lifecycle `archive` action
  mints URLs, drives the agent, caches the `workspace_snapshots` row, marks
  `archived`. Worktree intentionally KEPT (Restore reclaims it in Slice 3).
  Verified: `go test ./...` + `pnpm check` green; real-box acceptance deferred
  (no `DAYTONA_API_KEY`, like M3 Phase 6).
- ✅ **Slice 2 — Replay (browser + storage only).** Read-only replay of an
  archived Session with NO Runtime Computer (invariant #2). Off-box parsers:
  `lib/runtime/replay/conversation.ts` (JSONL→events, pinned to the Go `decode`
  by a shared golden fixture asserted from both languages) + `cast.ts`
  (asciinema v2). A lean xterm cast player (`use-cast-player`, play/pause/seek).
  `assembleReplay` reads every artifact from storage via signed URLs following
  the manifest pointers. Routes: `GET …/snapshots`, `GET …/replay`. UI: a
  read-only Replay page composing cast + reused `ConversationTimeline` + patch/
  Summary diff; Archive + Replay entry points added to the lifecycle controls
  (archived workspaces are now destroyable, cascading the Snapshot rows).
  Verified: `pnpm check` + `go test ./...` green; visual acceptance deferred.
- ✅ **Slice 3 — Restore.** `archived → restoring → ready`. The agent
  `snapshot.Materialize` downloads the tree + conversation via signed URLs,
  imports the bundle into the mirror, checks the branch out as a worktree,
  applies the (now untracked-inclusive) patch, places the JSONL where
  `claude --continue` finds the exact session, and **verifies before booting
  Claude** (branch imported ✓, worktree HEAD ✓, patch applied ✓, sessionId ✓) —
  a failure aborts without launching Claude. Idempotent (re-restore rebuilds).
  Archive now captures untracked text files (`git add -N`) so Restore rebuilds
  exact WIP. Next `restore` lifecycle action ensures a box via
  `ensureRuntimeComputer` (any box, not the original — portability), mints
  download URLs, drives the agent, and persists the new linkage. Restore button
  added to the lifecycle controls. Verified: `pnpm check` + `go test ./...`
  green (Materialize tested end-to-end against a real bundle/mirror: happy path,
  idempotency, missing-URL, and patch-conflict-aborts). Real-box acceptance
  (the plan's portability/idempotency run on Daytona) deferred.
- Follow-ups (real-box-gated): reclaim `casts/<id>` + worktree on archive
  (kept in place for now so unverified restore can't strand WIP); delete
  Snapshot storage objects on destroy (FK cascade drops the rows, not the
  bytes); capture untracked *binary* files (text-only today); verify the exact
  Supabase signed upload/download wire format on a real box; render the
  committed diff in Replay (needs the git bundle).

---

## Definition of done (the full loop)
Connect GitHub → New Workspace → Claude launches → watch live terminal + conversation →
close laptop → Claude keeps running → reconnect from another device → resume → archive → restore.
**Lands at the end of M3** (M4 completes archive/restore).

## Housekeeping / follow-ups
- ✅ Applied `20260804110000_runtime_computers.sql` + `20260805000000_runtime_computer_provision_timings.sql` to Supabase
  (`database.types.ts` hand-maintained in lockstep)
- ⬜ Rotate the `CLAUDE_CODE_OAUTH_TOKEN` shared earlier (treat as exposed)
- ⬜ Provision/configure Daytona credentials in the deployment secret manager,
  then complete the authenticated Phase 6 acceptance checklist.
- ⬜ Review/merge PR #9
- Known limitations (from Spike 4): interactive-TUI PTY input handling; heavy-workload/>30-min profiling; per-turn JSONL flush confirmation
