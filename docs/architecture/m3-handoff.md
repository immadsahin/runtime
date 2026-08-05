# M3 Handoff — the Workspace Session experience

Handoff for the agent picking up **Milestone 3**. Read this, then
[`PROGRESS.md`](./PROGRESS.md), [`protocol.md`](./protocol.md), and
[`runtime-agent.md`](./runtime-agent.md). All file references are on `main`.

## Where we are

Phase 0, **M1, and M2 are complete and on `main`.** The full backend execution
path exists and was verified on a real Daytona box (see
[`spike-m2pt2-report.md`](./spike-m2pt2-report.md)):

```
Project → Runtime Computer (Daytona box, runtime-agent) → Workspace (tmux + git worktree)
        → Claude Code → PTY over WebSocket (signed preview URL)
```

The batch/SSE job model is fully retired. **runtime-agent owns active-execution
state** (there is no more `jobs`-driven execution; don't reintroduce it).

## Primary Runtime Object: the Workspace Session

M3 introduces the **Workspace Session** — the live execution of Claude Code
inside a Workspace. It is the central abstraction for everything that follows.

A Workspace Session owns:
- the **PTY**,
- the **Claude process**,
- the **conversation stream**,
- the **status**,
- the **lifetime**.

The UI renders four **projections of the same Session** — never of each other:

```
Workspace
        │
        ▼
Workspace Session
        │
 ┌──────┼──────────────┬─────────┐
 ▼      ▼              ▼         ▼
PTY   Conversation   Status     Diff
(interact) (understand) (state)  (git)

Terminal      ← PTY
Conversation  ← JSONL events
Status        ← Session state events
Diff          ← Git
```

Design M3 around this object. It is the stable abstraction the Runtime SDK will
expose and the Mission Engine will observe — see *Future-proofing* below.

## M3 goal / definition of done

Turn the working backend into the first real **Workspace Experience**. When M3 is
done, the [full loop](./PROGRESS.md#definition-of-done-the-full-loop) works:

> Create workspace → Claude launches → watch **live terminal + Conversation
> Timeline** → close laptop → Claude keeps running → reconnect → resume, with
> **status + git diff** visible.

M3 checklist:
- **Workspace Experience** (`app/workspaces/[id]/page.tsx` is a ~37-line stub
  after the job UI was removed — rebuild it as the Session experience).
- **Live terminal** — xterm.js over the signed-preview WebSocket (PTY projection).
- **Conversation Timeline** — see below (JSONL-event projection).
- **Status** — rendered only from `WorkspaceStateChanged` events.
- **Diff** — git projection (diff API already exists).
- **Create / list** workspaces wired to **lazy provisioning**.
- **Workspace Summary** endpoint (required artifact — see gaps).

### The Conversation Timeline (not a "chat view")

It is not chat. It is an ordered timeline of the same event types Claude Code
emits: `User → Claude → Thinking → Tool → Tool Result → Claude → Token Usage →
State → …`. Render it as a timeline of `AgentEvent`s, close to Claude Code itself.

## What already exists (build on these — don't rebuild)

| Piece | File | Notes |
| --- | --- | --- |
| Typed agent client | `lib/runtime/agent-client.ts` | `createWorkspace / startWorkspace / stopWorkspace / archiveWorkspace`, and **`ptyUrl(identity)`** → the `wss://…/pty?token=…` the browser opens. |
| Runtime tokens | `lib/runtime/runtime-token.ts` | `mintRuntimeToken` (HS256, **5-min TTL** — see gotchas). Server-only. |
| Daytona provider | `lib/runtime/daytona-provider.ts` | provision/start/destroy against Daytona; already verified live. |
| Provider resolution | `lib/runtime/resolve.ts`, `lib/runtime/provider.ts` | `resolveProvider(workspace)` → 503/409-shaped failures. |
| **Frozen protocol** | `lib/runtime/agent-protocol.ts` | zod schemas the UI **must** speak (below). Do not invent ad-hoc JSON. |
| Diff API | `app/api/workspaces/[id]/changes/route.ts` | changed-file list + bounded per-file diff. Reuse for the diff projection. |
| Lifecycle API | `app/api/workspaces/[id]/lifecycle/route.ts` | suspend/resume/destroy, owner-gated. |
| Publish API | `app/api/workspaces/[id]/publish/route.ts` | commit + push + open PR. |
| Agent (Go) | `runtime-agent/internal/server/server.go` | serves `GET /health`, `POST /workspaces`, `POST /workspaces/{id}/{start,stop,archive}`, `GET /pty` (WS). |
| Conversation watcher (Go) | `runtime-agent/internal/conversation/watcher.go` | tails Claude's session JSONL → `AgentEvent`s. **Not yet exposed over a socket** (see gaps). |

### The protocol the UI must speak (`agent-protocol.ts`)

Terminal WebSocket (`/pty`):
- **Client → agent** (`PtyClientMessage`): `{t:"input",data}`, `{t:"resize",cols,rows}`, `{t:"ping"}`.
- **Agent → client** (`PtyServerMessage`): `{t:"output",data,seq}` (coalesced, redacted, monotonic `seq`), `{t:"role",writer}` (**single-writer**: one connection holds the keyboard, others read-only), `{t:"exit",code}` (offer resume), `{t:"pong"}`.

Conversation events (`AgentEvent`, derived from JSONL — **not** parsed from the PTY):
- `ConversationMessage {t:"message", role, content: ContentBlock[]}` where `ContentBlock` ∈ text / thinking / tool_use / tool_result.
- `TokenUsage {t:"usage", …}`.
- `WorkspaceStateChanged {t:"state", state: starting|running|exited|archived|degraded}`.

## M3 Invariants

Hold these to prevent future regressions:

1. **The terminal is never parsed.** The Conversation Timeline is never derived
   from ANSI/terminal output.
2. **PTY and Conversation are independent projections of the same Workspace
   Session.** PTY exists for *interaction*; Conversation exists for
   *understanding*. Neither is derived from the other.
3. **Status is rendered only from `WorkspaceStateChanged` events.** Never infer
   status from terminal output or heuristics.
4. **No polling.** Every projection subscribes to events (below).

## Event ownership & subscriptions

The Workspace Session is the single source; each stream has one owner:

```
Workspace Session
   ├─ PTY events              → Terminal
   ├─ Conversation events     → Conversation Timeline
   ├─ Workspace State events  → Status
   └─ Git events              → Diff
```

Every UI component **subscribes**; none polls.

## What M3 must BUILD (the gaps — confirmed absent on `main`)

1. **Browser-facing session endpoint.** Nothing in `app/` exposes the PTY URL or
   mints a token to the browser today. Add a route (e.g. `POST
   /api/workspaces/[id]/session`) that: owner-checks → `resolveProvider` →
   builds the `AgentTarget` → returns `AgentClient.ptyUrl(identity)`. The secret
   and minting stay **server-side**; the browser only ever gets the finished
   `wss://` URL (token already embedded).
2. **Conversation event channel on the agent + a browser route.** The watcher
   produces `AgentEvent`s but `server.go` has **no events route**. Add a
   `GET /events` (WS or SSE) handler on the agent that streams `AgentEvent`s
   (auth via Runtime token, same as `/pty`), then a Next route/proxy the browser
   subscribes to. This is the one M3 item that touches Go.
3. **Workspace Summary endpoint.** Required artifact. The runtime-agent already
   has the data; expose a `GET /workspaces/{id}/summary` (agent) + Next route
   returning a compact Session summary (state, last activity, token usage,
   changed-file count, last assistant message). The UI need not render it
   beautifully yet — but it must exist, because the **Mission Engine consumes
   Workspace Summary, not the raw Conversation**.
4. **Lazy provisioning (`ensureRuntimeComputer`).** Not present (deferred out of
   M2 pt2). Wire workspace create/list so the first workspace on a project
   provisions the Runtime Computer via `daytona-provider`, persists the
   `runtime_computers` row, then creates the workspace on it. Create route today:
   `app/api/projects/[id]/workspaces/route.ts`.
5. **The Workspace Experience** — assemble the four projections (terminal,
   Conversation Timeline, status, diff) around the Session.

## Recommended sequencing (prove the risky transport first)

1. **UI spike:** get a real xterm.js terminal streaming over the signed-preview
   WS against a **live box**, with `input`/`resize`/`output`/`role` working,
   before building the full experience. Highest-risk integration.
2. Add the conversation `/events` channel (Go + Next) and render the Timeline.
3. Add the Workspace Summary endpoint.
4. Wire lazy provisioning + create/list.
5. Assemble the Workspace Experience.
6. Run the Acceptance Test (below).

## Gotchas

- **Two URLs per computer.** Control calls (create/start) go **server→agent** over
  the *standard* preview URL + preview-token header. The browser terminal uses
  the *signed* preview URL (token in the host) — that's what `ptyUrl` builds.
  Don't cross them.
- **5-minute token TTL.** Mint per connection; on WS close/expiry, re-fetch a
  fresh session URL and reconnect. Don't cache a token in the client.
- **Single-writer terminal.** Honor `{t:"role",writer:false}` → render read-only.
- **Redaction is already handled** agent-side before `output` is sent; don't
  re-implement it, and never log raw frames.
- **Local dev:** `.env.local` needs Supabase + `GITHUB_PAT` +
  `RUNTIME_OWNER_GITHUB_LOGIN`. `RUNTIME_PROVIDER=daytona` exercises the real
  path (needs Daytona creds); `local` runs worktrees on-machine but has no
  runtime-agent/PTY, so the Session terminal is Daytona-only.
- Don't reintroduce `jobs`/SSE. The agent owns execution state now.

## Acceptance Test (definition of done)

Run `pnpm check`, then against a **real box**:

1. Create Workspace
2. Runtime Computer provisions (if needed)
3. Claude launches
4. Terminal becomes interactive
5. Conversation Timeline begins receiving events
6. Git Diff updates while Claude edits files
7. Close browser
8. Claude continues running
9. Reopen browser
10. Terminal reconnects
11. Conversation resumes
12. Status remains consistent (driven only by state events)
13. Publish still works

Record it like the prior spikes (a short report under `docs/architecture/`).

## Future-proofing

The **Workspace Session is intentionally the stable Runtime abstraction.** Future
features — Mission Engine, notifications, automation, the Runtime SDK — should
consume **Session state (and the Workspace Summary), not terminal output.** M3
isn't just adding UI; it defines the live runtime abstraction every higher-level
feature builds on.

## Pointers
- Progress + full-loop DoD: [`PROGRESS.md`](./PROGRESS.md)
- Protocol detail: [`protocol.md`](./protocol.md) · Agent detail: [`runtime-agent.md`](./runtime-agent.md)
- What M2 proved live: [`spike-m2pt2-report.md`](./spike-m2pt2-report.md), [`spike4-runtime-report.md`](./spike4-runtime-report.md)
- The product this unblocks: [`mission-engine-v0.md`](./mission-engine-v0.md) (consumes the Workspace Session + Summary; needs M3 + a completion event)
