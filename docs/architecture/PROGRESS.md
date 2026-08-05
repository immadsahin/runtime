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
- ⬜ Phase 4 — Lazy provisioning `ensureRuntimeComputer` (unique constraint + advisory lock)
- ⬜ Phase 5 — Assemble the Workspace Experience (four projections around one Session) — **API freeze after this phase**
- ⬜ Phase 6 — Acceptance test on real Daytona + `spike-m3-report.md`
- ⬜ Phase 7 — Dogfood: an uninterrupted work session in Runtime without opening Conductor

## Milestone 4 — Archive / Replay / Resume — ⬜ NOT STARTED
- ⬜ PTY cast capture + upload to object storage (Supabase Storage)
- ⬜ Archive (kill tmux, upload artifacts, mark read-only)
- ⬜ Resume (replay cast + `claude --continue`)
- ⬜ Conversation + terminal replay from stored artifacts

---

## Definition of done (the full loop)
Connect GitHub → New Workspace → Claude launches → watch live terminal + conversation →
close laptop → Claude keeps running → reconnect from another device → resume → archive → restore.
**Lands at the end of M3** (M4 completes archive/restore).

## Housekeeping / follow-ups
- ✅ Applied `20260804110000_runtime_computers.sql` + `20260805000000_runtime_computer_provision_timings.sql` to Supabase
  (`database.types.ts` hand-maintained in lockstep)
- ⬜ Rotate the `CLAUDE_CODE_OAUTH_TOKEN` shared earlier (treat as exposed)
- ⬜ Review/merge PR #9
- Known limitations (from Spike 4): interactive-TUI PTY input handling; heavy-workload/>30-min profiling; per-turn JSONL flush confirmation
