# Spike Report — M3 Workspace Session

Report for the Workspace Session milestone. Each phase gets its own section;
sections are filled in as the phase completes. The overall Acceptance Test +
dogfood outcome live at the bottom.

Format follows the prior spike reports
([`spike-m2pt2-report.md`](./spike-m2pt2-report.md),
[`spike4-runtime-report.md`](./spike4-runtime-report.md)).

---

## Phase 1 — PTY transport spike

**Goal.** Prove the PTY transport end-to-end over a real Runtime Computer.
Freeze the transport if it holds; if not, fix the wire contract before
building any UI.

### Contract deltas landed in Phase 1

Two frozen-protocol claims were unimplemented before Phase 1. Both are now
honored on the agent side:

1. **`output` frames are coalesced.** New `ptyx.Coalescer` (16 ms flush /
   4 KB threshold) buffers PTY bytes and emits one frame per tick or burst.
   Seq is per-socket and strictly monotonic.
2. **`role` frames enforce a single writer per workspace.** New `ptyx.Broker`
   assigns the writer slot to the first WS attach; further attaches become
   readers. If the writer disconnects, the oldest waiting reader is promoted
   and re-notified. Reader `input` frames are dropped.

### Security hardening added before Phase 5 completion

The early spike deliberately left PTY redaction as a pass-through. That is no
longer acceptable once a Runtime Computer receives Claude credentials:

- The agent removes `RUNTIME_AGENT_SECRET`, `RUNTIME_AGENT_ROOT`, and `PORT`
  from the environment passed to tmux/Claude. Only the supported Claude
  credentials remain available to the interactive process.
- `server.Redactor` replaces known credential values before PTY output crosses
  the WebSocket. It keeps a suffix between reads, so a secret split across two
  PTY/coalescer chunks cannot leak.
- Control routes retain verified token claims and reject any body/path workspace
  that differs from `claims.workspaceId`; a token for one workspace cannot
  inspect, stop, archive, resume, or destroy another workspace on the same
  Runtime Computer.
- Runtime tokens now require every identity claim plus a positive expiry;
  WebSocket input is limited to 64 KiB and invalid/unsafe resize frames are
  dropped.

### Client surface added

- `SessionUrls` type in `agent-protocol.ts` (+ fixture + Go struct + drift test).
- `POST /api/workspaces/[id]/session` — mints Runtime tokens server-side,
  returns `{ ptyUrl }`. `eventsUrl`/`summary` are optional in the shape and
  land in Phases 2/3 without a schema break.
- `lib/runtime/session-client.ts` — browser-safe `openTerminal(ptyUrl, xterm)`;
  never imports server-only code.
- `hooks/use-session-attachment.ts` + `hooks/use-session-terminal.ts` — shared
  URL fetch + reconnect, xterm instance kept alive across reconnects.
- `app/spike/pty/[id]` — dev-only spike page (not linked from nav) to drive
  the transport by hand.

### Automated coverage

- Go: `ptyx` package — broker (5 tests: election, promotion, isolation,
  reader-detach no-op, empty-then-rejoin) + coalescer (4 tests: tick flush,
  threshold flush, empty ticker, stop drains).
- TS: `SessionUrls` fixture round-trip + negative parse tests.
- `scripts/verify-daytona.ts` — extended with a `[4b] writer election` step
  that opens two concurrent PTY sockets and asserts `first=writer,
  second=reader` on a live box.

### Live-box results — 2026-08-05

`scripts/verify-daytona.ts` on `octocat/Hello-World` (no Claude token this
run; PTY attach is what mattered):

| Stage           | ms     |
| --------------- | ------ |
| sandbox_create  | 3 301  |
| agent_upload    | 6 168  |
| agent_boot      | 1 118  |
| health_check    | 763    |
| mirror_clone    | 1 334  |
| **total**       | 14 471 |

Transport behavior observed:

- Signed preview URL handshake + Runtime-token verification: `[4] WS /pty` opened cleanly.
- 55 bytes of PTY output flowed (tmux banner + prompt), then exit — expected
  without a Claude token; live Claude was proven in Spike 4.
- **Writer election on two concurrent WS: `first=writer, second=reader`.** ✅
  Broker's per-workspace slot works against real tmux attaches.
- Clean shutdown: `stopWorkspace` succeeded; sandbox destroyed with no orphan.

Not covered by automated verify (fold into Phase 6):

- 5-minute token TTL drill (leave a browser tab idle, watch the WS close and
  the hook silently refetch + reattach with scrollback preserved).
- Second-browser-tab writer/reader flip in the actual xterm UI (the spike
  page renders the role pill; drive it by hand).
- Real Claude interactivity + bursty-output coalescing — needs
  `CLAUDE_CODE_OAUTH_TOKEN` and belongs in the acceptance test.

### Freeze / unfreeze

Frozen for M3:

- **Wire protocol** — PTY frame shapes, seq/role/exit/pong semantics
  (`agent-protocol.ts` PTY section, `agent-protocol.fixtures.json` PTY entries,
  `runtime-agent/internal/protocol` PTY structs).
- **Agent PTY path** — `runtime-agent/internal/server/server.go` PTY handler,
  `runtime-agent/internal/ptyx/{broker,coalescer,session}.go`.

Provisionally frozen — will be exercised for the first time in a real user
flow during Phase 5/6, so bug fixes are allowed there without a re-spike:

- `lib/runtime/session-client.ts`
- `hooks/use-session-attachment.ts`, `hooks/use-session-terminal.ts`
- `app/api/workspaces/[id]/session/route.ts`

If Phase 6 turns up a wire-level bug, re-open this section — fix the wire
first, both languages + fixtures, then re-run Phase 1 before advancing.

---

## Phase 2 — Conversation /events SSE + Timeline

**Goal.** Two independent live windows into the same Workspace Session:
Terminal (PTY) and Conversation (AgentEvents). Correctness — no dupes, no
skips across disconnect/reconnect — is the only objective.

### Contract additions

- **Watcher event IDs.** `conversation.Event` now carries `ID` = the JSONL
  byte offset AT THE END of the record. That value is the resume cursor;
  it maps 1:1 to `w.offset`, so there is no separate seq state to keep
  in sync. Watcher accepts a `PathFunc` so subscribers can attach before
  Claude has written its JSONL (returns "" until the file appears).
- **SSE `/events` handler.** Verifies the Runtime token (query param), reads
  `Last-Event-ID` from the header or `?lastEventId=` from the query, and
  streams `id: <offset>\ndata: <AgentEvent JSON>\n\n` frames. Heartbeat
  comments (`:keepalive`) every 20 s so proxies don't kill idle streams. On
  fresh connect (offset == 0) the handler emits a synthetic
  `WorkspaceStateChanged` frame first; resume connects skip the state
  re-emit.
- **`SessionLog` on workspace.Service.** Resolves the Claude JSONL path via
  Claude Code's slug convention (`/` and `.` in the worktree path → `-`) and
  returns the newest `.jsonl` in that project dir, or "" if none.

### Client surface added

- `AgentClient.eventsUrl(identity)` — sibling of `ptyUrl`; https, not ws.
- `POST /session` response now includes `eventsUrl` (still no `summary`;
  Phase 3).
- `lib/runtime/session-client.ts::subscribeEvents(url, onEvent, opts)` —
  browser-safe. Validates every incoming payload against the `AgentEvent`
  zod union.
- `lib/runtime/conversation-events.ts` — pure appendEvent helper (dedup +
  state collapse); dependency-free so it's Node-testable.
- `hooks/use-conversation-stream.ts` — owns the `lastEventId` cursor across
  reconnects; child of `useSessionAttachment` so the URL fetch is shared
  with the terminal.
- `components/conversation-timeline.tsx` — `@tanstack/react-virtual` list of
  AgentEvents. Renders `state` / `usage` / `message` (with text / thinking /
  tool_use / tool_result). Intentionally minimal — no markdown, no grouping,
  no collapsing. Auto-follows only when the user is near-bottom.
- Spike page now shows both projections side by side (PTY left, Timeline
  right) — same `workspaceId`, two independent event streams.

### Correctness coverage

- **Go — the resume contract.** `conversation/watcher_test.go` (5 tests:
  end-of-line IDs, resume-from-offset delivers only later events with a
  strictly greater ID, partial trailing line buffered across writes,
  app-internal record types ignored, waits for the JSONL file to appear).
  `server/events_test.go` (4 tests: 401 on bad token, initial state frame,
  **fresh-connect delivers full backlog with monotonic IDs**, and — the
  invariant we care about — **connect → read msg1 → disconnect → append
  msg2+msg3 → reconnect with `Last-Event-ID: <msg1.id>` → receive exactly
  msg2, msg3 with no dupe of msg1 and no re-emitted state**).
- **TS.** `test/conversation-stream.test.ts` unit-tests the pure
  `appendEvent` helper: id-based dedup, state collapse, missing-id
  tolerance.

### Live-box results — 2026-08-05

Second `verify-daytona.ts` run after building the Phase 2 agent binary:

| Stage           | ms     |
| --------------- | ------ |
| sandbox_create  | 2 723  |
| agent_upload    | 6 126  |
| agent_boot      | 1 090  |
| health_check    | 740    |
| mirror_clone    | 1 211  |
| **total**       | 13 566 |

Transport behavior observed:

- `[4c] SSE /events` — `Content-Type: text/event-stream`, first frame
  arrived as `{t:"state", state:"starting"}`. "starting" is the correct
  observation without a Claude token — no JSONL means `SessionLog()` is `""`
  which resolves to `starting`. With a Claude token in place, expect
  `running` immediately after Claude writes its first line.
- Writer election, PTY attach, sandbox cleanup — all unchanged from Phase 1.

Not covered by automated verify (fold into Phase 6):

- Multi-connect resume drill with real Claude output — requires
  `CLAUDE_CODE_OAUTH_TOKEN`. The Go test proves the resume contract with
  fixture JSONL; the live drill is confirmation, not proof.
- Browser-side `EventSource` auto-reconnect via the `Last-Event-ID` header
  path. The agent honors it (`server.events` reads the header first), but
  the drive-it-by-hand check happens in Phase 6/7.

### Frozen invariant

> **Conversation is a durable event log, not a UI.**

Every current and future consumer — Mission Engine, notifications,
analytics, the Runtime SDK, search — subscribes to the same AgentEvent
stream. The Timeline is one projection of it. Do not let the Timeline
become the source of truth.

Frozen for M3:

- **Wire protocol** — `AgentEvent` union (`message` / `usage` / `state`),
  SSE frame shape, `id:` = JSONL byte offset, `Last-Event-ID` /
  `?lastEventId=` resume semantics.
- **Agent event pipeline** — `conversation/watcher.go` (byte-offset tail +
  path resolver), `server.events` (SSE handler + heartbeat + resume).

Provisionally frozen — first exercised in a real user flow in Phase 5/6:

- `lib/runtime/session-client.ts::subscribeEvents`
- `lib/runtime/conversation-events.ts`
- `hooks/use-conversation-stream.ts`
- `components/conversation-timeline.tsx`

## Phase 3 — Workspace Summary

**Goal.** Freeze and expose the canonical `WorkspaceSummary` — the object every
downstream consumer (Mission Engine, the M4 Snapshot manifest, notifications,
the Runtime SDK, analytics) reads. M3 owns the type; nothing else defines it.

### Frozen shape (matches `docs/architecture/m4-plan.md`)

```ts
type WorkspaceSummary = {
  state: "starting" | "running" | "exited" | "archived" | "degraded";
  startedAt: string;              // RFC3339 UTC
  endedAt: string | null;         // null while running; frozen at stop
  duration: number;               // whole seconds; frozen at endedAt after stop
  lastActivity: string;           // RFC3339 UTC
  tokenUsage: {                   // numbers-only projection of TokenUsage
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    // service_tier intentionally lives on the standalone TokenUsage event,
    // not on the Summary, so M4's `z.record(z.string(), z.number())`
    // placeholder validator accepts M3-produced Summaries verbatim.
  };
  changedFiles: number;           // len(status paths)
  filesTouched: string[];         // sorted union of status paths + log-since-upstream paths
  commitCount: number;            // commits ahead of upstream
  lastAssistantMessage: string | null;
};
```

Ownership: `lib/runtime/agent-protocol.ts` (zod) and
`runtime-agent/internal/protocol/protocol.go` (struct) — both live in M3.

### Agent implementation

- `workspace.Summary` — event-driven fields folded from a per-workspace
  `conversation.Watcher` collector goroutine (state / timestamps / tokenUsage /
  lastAssistantMessage).
- `workspace.Service.beginSummary` + `endSummary` — launched from `Start` /
  `Resume`, ended (endedAt fixed, collector cancelled) from `Stop`.
- Git-derived fields (`changedFiles`, `filesTouched`, `commitCount`) shelled out
  at `Snapshot()` time — cheap enough for Mission's polling cadence, always
  fresh. `filesTouched` is a sorted union of `git status --porcelain` paths and
  commits ahead of upstream (`git log @{upstream}..HEAD --name-only`).
- `GET /workspaces/{id}/summary` on the agent — same auth as the other control
  routes (Bearer Runtime token).

### Next surface

- `AgentClient.workspaceSummary(identity)` on the server — validates the
  response with the zod schema.
- `GET /api/workspaces/[id]/summary` — the Mission-Engine-facing poll surface.
- `POST /api/workspaces/[id]/session` now returns `summary` inline, so the
  browser has it on first paint without an extra round-trip.

### Correctness coverage

- **Go — Summary collector.** `workspace/summary_test.go`:
  - Starting summary shape (state, empty `filesTouched: []`).
  - `applyEvent` folds message + accumulates usage across turns; keeps the
    latest assistant text.
  - `stop()` sets `endedAt` + `state=exited`; **duration is frozen at endedAt
    and does not keep counting up on subsequent snapshots.**
  - Real git worktree: `changedFiles` counts status paths only; `filesTouched`
    is the sorted union of status + commits-ahead-of-upstream; `commitCount`
    matches `git rev-list --count @{upstream}..HEAD`.
  - `Service.SummaryOf` for a never-started workspace returns a `starting`
    placeholder (shape stays stable).
- **Go — HTTP handler.** `server/summary_test.go`: 401 on bad token; canonical
  shape end-to-end (every field present with the right type/zero value; empty
  `filesTouched` serializes as `[]`, not `null`).
- **TS.** Fixture round-trip + zod validation via the existing drift guard —
  two `WorkspaceSummary` fixtures (running + exited) validate on both sides.

### Live-box results — 2026-08-05

Third `verify-daytona.ts` run against a real Daytona box:

| Stage           | ms     |
| --------------- | ------ |
| sandbox_create  | 3 032  |
| agent_upload    | 6 774  |
| agent_boot      | 1 209  |
| health_check    | 841    |
| mirror_clone    | 1 420  |
| **total**       | 15 310 |

`[4d] GET /workspaces/verify-ws/summary` returned the canonical shape end-to-end:

```
state=running duration=12s changedFiles=0 commitCount=0 filesTouched=0
tokens.in=0 tokens.out=0
```

Every frozen field materialized with the right type and value for a fresh,
Claude-token-less session (Hello-World repo has no dirt; no Claude → no tokens).

### Frozen API — the M3 API Freeze rule now applies

Per [`session-contract.md`](./session-contract.md), M3 is the canonical owner
of `WorkspaceSummary`. Consumers import (Mission Engine, Runtime SDK,
notifications) or mirror the struct (M4 archive Snapshot). **No new fields may
be added before Phase 5 completes** unless a verified Phase 6/7 bug requires
one; additive-only after that, and only for cause.

Frozen for M3:

- `WorkspaceSummary` shape (TS zod + Go struct) and its two fixtures.
- Agent event-driven fields ownership: `workspace.Summary` folds the JSONL
  event stream and no consumer computes them independently.
- `GET /workspaces/{id}/summary` (agent) + `GET /api/workspaces/[id]/summary`
  (Next) as Mission's polling surface.

Provisionally frozen — first exercised in a real user flow in Phase 5/6:

- Inline `summary` on the `/session` response.
- Git-stats computation choices (`--porcelain` for changedFiles;
  `@{upstream}..HEAD` for the ahead-of-base fields).

## Phase 4 — Lazy provisioning

### Implementation

- `ensureRuntimeComputer` atomically claims or reuses one `runtime_computers`
  record per project. A winning request provisions the Daytona Runtime Computer
  and persists the agent connection metadata; concurrent workspace requests
  wait for/reuse that row instead of creating duplicate boxes.
- Workspace creation resolves the project computer, refreshes the shared bare
  mirror, asks the agent to create an isolated worktree, starts Claude, and
  saves the computer/worktree/session linkage on the workspace.
- Daytona lifecycle routing now drives agent-backed resume and destroy paths;
  changed-file and bounded-diff reads, commit/push, and PR publishing execute
  in the Daytona worktree rather than a control-plane checkout.

### Coverage

- `test/ensure-runtime-computer.test.ts` covers concurrent first-workspace
  creation, failed provision persistence, and a later retry claim.
- Daytona provider, agent client, Git, and lifecycle route tests exercise the
  typed control-plane contracts.

## Phase 5 — Workspace Experience

### Implementation

- `WorkspaceSession` replaces the terminal placeholder in the studio with an
  xterm terminal, a virtualized structured `ConversationTimeline`, connection
  indicators, writer/read-only role, exit handling, and a reconnect action.
- `useSessionAttachment` owns refresh of short-lived PTY/SSE URLs. Terminal
  and conversation hooks share that attachment, preserving terminal scrollback
  and the JSONL event cursor while coalescing simultaneous reconnects.
- Terminal output and Claude JSONL-derived events remain independent
  projections. Only `WorkspaceStateChanged` events update authoritative
  conversation state; terminal text is never interpreted as conversation data.

### Current verification

- `pnpm typecheck`, `pnpm lint` (one existing TanStack Virtual compatibility
  warning), `pnpm test` (85 tests), and `cd runtime-agent && go test ./...`
  pass.
- The managed preview renders `/signin` with the GitHub OAuth action.
- The authenticated end-to-end acceptance remains blocked in this sandbox by
  missing Daytona credentials; this is not represented as a completed live-box
  result.

**The Session API is now frozen for M3 except for verified Phase 6 defects.**

## Phase 6 — Acceptance Test on a live box

_Fill in observations against each of the 13 handoff steps + timings +
screenshots._

## Phase 7 — Dogfood

_Uninterrupted work session in Runtime, without opening Conductor. Track
every friction point and grade the milestone against the real question:
"Would I choose Runtime tomorrow morning?"_
