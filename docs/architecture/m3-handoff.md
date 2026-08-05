# M3 Handoff — UI (live terminal + conversation + diff)

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

## M3 goal / definition of done

Turn the working backend into a usable product page. When M3 is done, the
[full loop](./PROGRESS.md#definition-of-done-the-full-loop) works:

> Create workspace → Claude launches → watch **live terminal + structured
> conversation** → close laptop → Claude keeps running → reconnect → resume,
> with **status + git diff** visible.

M3 checklist (from the tracker):
- Workspace page layout (`app/workspaces/[id]/page.tsx` is currently a ~37-line
  stub after the job UI was removed — rebuild it).
- **Live terminal** — xterm.js over the signed-preview WebSocket.
- **Structured conversation view** — from the agent's conversation event stream.
- **Status + git diff** panel (diff API already exists — see below).
- **Create / list** workspaces wired to **lazy provisioning**.

## What already exists (build on these — don't rebuild)

| Piece | File | Notes |
| --- | --- | --- |
| Typed agent client | `lib/runtime/agent-client.ts` | `createWorkspace / startWorkspace / stopWorkspace / archiveWorkspace`, and **`ptyUrl(identity)`** → the `wss://…/pty?token=…` the browser opens. |
| Runtime tokens | `lib/runtime/runtime-token.ts` | `mintRuntimeToken` (HS256, **5-min TTL** — see gotchas). Server-only. |
| Daytona provider | `lib/runtime/daytona-provider.ts` | provision/start/destroy against Daytona; already verified live. |
| Provider resolution | `lib/runtime/resolve.ts`, `lib/runtime/provider.ts` | `resolveProvider(workspace)` → 503/409-shaped failures. |
| **Frozen protocol** | `lib/runtime/agent-protocol.ts` | zod schemas the UI **must** speak (below). Do not invent ad-hoc JSON. |
| Diff API | `app/api/workspaces/[id]/changes/route.ts` | changed-file list + bounded per-file diff. Reuse for the diff panel. |
| Lifecycle API | `app/api/workspaces/[id]/lifecycle/route.ts` | suspend/resume/destroy, owner-gated. |
| Publish API | `app/api/workspaces/[id]/publish/route.ts` | commit + push + open PR. |
| Agent (Go) | `runtime-agent/internal/server/server.go` | serves `GET /health`, `POST /workspaces`, `POST /workspaces/{id}/{start,stop,archive}`, `GET /pty` (WS). |
| Conversation watcher (Go) | `runtime-agent/internal/conversation/watcher.go` | tails Claude's session JSONL → `AgentEvent`s. **Not yet exposed over a socket** (see gaps). |

### The protocol the UI must speak (`agent-protocol.ts`)

Terminal WebSocket (`/pty`):
- **Client → agent** (`PtyClientMessage`): `{t:"input",data}`, `{t:"resize",cols,rows}`, `{t:"ping"}`.
- **Agent → client** (`PtyServerMessage`): `{t:"output",data,seq}` (coalesced, redacted, monotonic `seq`), `{t:"role",writer}` (**single-writer**: one connection holds the keyboard, others are read-only), `{t:"exit",code}` (offer resume), `{t:"pong"}`.

Conversation events (`AgentEvent`, derived from JSONL — **not** parsed from the PTY):
- `ConversationMessage {t:"message", role, content: ContentBlock[]}` where `ContentBlock` ∈ text / thinking / tool_use / tool_result.
- `TokenUsage {t:"usage", …}`.
- `WorkspaceStateChanged {t:"state", state: starting|running|exited|archived|degraded}`.

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
3. **Lazy provisioning (`ensureRuntimeComputer`).** Not present
   (deferred out of M2 pt2). Wire workspace create/list so the first workspace
   on a project provisions the Runtime Computer (Daytona box) via
   `daytona-provider`, persists the `runtime_computers` row, then creates the
   workspace on it. Create route today: `app/api/projects/[id]/workspaces/route.ts`.
4. **The workspace page itself** — xterm.js terminal + conversation view + status
   + diff, assembled from the above.

## Recommended sequencing (keep the project's "prove the risky transport first" discipline)

1. **UI spike:** get a real xterm.js terminal streaming over the signed-preview
   WS against a **live box**, with `input`/`resize`/`output`/`role` working, before
   building the full page. This is the highest-risk integration.
2. Add the conversation `/events` channel (Go + Next) and render the message list.
3. Wire lazy provisioning + create/list.
4. Assemble the page: terminal + conversation + status + diff panel.
5. Verify the full loop (below).

## Gotchas

- **Two URLs per computer.** Control calls (create/start) go **server→agent** over
  the *standard* preview URL + preview-token header. The browser terminal uses
  the *signed* preview URL (token in the host) — that's what `ptyUrl` builds.
  Don't cross them.
- **5-minute token TTL.** `mintRuntimeToken` tokens expire fast. Mint per
  connection; on WS close/expiry, re-fetch a fresh session URL and reconnect.
  Don't cache a token in the client.
- **Single-writer terminal.** Honor `{t:"role",writer:false}` → render read-only
  (no input) for non-writer connections.
- **Redaction is already handled** agent-side before `output` is sent; don't
  re-implement it, but never log raw frames either.
- **Local dev:** `.env.local` needs Supabase + `GITHUB_PAT` +
  `RUNTIME_OWNER_GITHUB_LOGIN`. `RUNTIME_PROVIDER=daytona` exercises the real
  path (needs Daytona creds); `local` runs worktrees on-machine but has no
  runtime-agent/PTY, so the terminal is Daytona-only.
- Don't reintroduce `jobs`/SSE. The agent owns execution state now.

## How to verify M3 is done

Run `pnpm check` (typecheck + lint + tests) and, against a **real box**:
create a workspace → Claude launches → terminal streams live → conversation view
populates → close the tab → reopen → session resumes → diff panel shows changes.
Record it like the prior spikes (a short report under `docs/architecture/`).

## Pointers
- Progress + full-loop DoD: [`PROGRESS.md`](./PROGRESS.md)
- Protocol detail: [`protocol.md`](./protocol.md) · Agent detail: [`runtime-agent.md`](./runtime-agent.md)
- What M2 proved live: [`spike-m2pt2-report.md`](./spike-m2pt2-report.md), [`spike4-runtime-report.md`](./spike4-runtime-report.md)
- The product this unblocks: [`mission-engine-v0.md`](./mission-engine-v0.md) (needs M3 + a workspace-completion event)
