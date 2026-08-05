# Workspace Session — Contract

The Workspace Session is the primary Runtime object. It is the live execution of
Claude Code inside a Workspace. Everything M3 builds — and everything Mission
Engine, the Runtime SDK, notifications, and future automation will build — reads
this contract and no other.

This document is intentionally short. It is invariant. See
[`m3-handoff.md`](./m3-handoff.md), [`protocol.md`](./protocol.md), and
[`runtime-agent.md`](./runtime-agent.md) for the shape of the wire.

## Inputs

- **Prompt** — the initial prompt Claude Code is launched with (bound at
  Session creation, not mutated afterwards).
- **PTY input** — bytes typed into the terminal by the single writer client.
- **Lifecycle actions** — `start`, `stop`, `archive`, `suspend`, `resume`,
  `destroy`, `publish` (owner-gated, idempotent).

## Outputs

- **PTY stream** — coalesced, redacted `output` frames with a monotonic `seq`;
  one writer, N read-only observers.
- **Conversation events** — ordered `AgentEvent`s (`message` / `usage` /
  `state`) with a monotonic `seq` (JSONL byte offset).
- **State events** — `WorkspaceStateChanged` transitions between
  `starting | running | exited | archived | degraded`.
- **Git events** — `WorkspaceFilesChanged` emitted when the worktree mutates
  (`.git/` excluded); the client refetches `/changes` on receipt.
- **Summary** — a compact struct maintained in the agent and served by
  `GET /workspaces/{id}/summary`. What Mission Engine consumes.

## Guarantees

- **Reconnect-safe.** Losing the browser (network, laptop lid, token expiry)
  never loses Session state. The Session lives in the agent, not the client.
- **Idempotent.** Every lifecycle action can be retried; every event carries a
  `seq` so a redelivery is a no-op for the consumer.
- **Event-ordered.** For each stream (PTY, Conversation, State, Files), `seq`
  is strictly monotonic and gap-free for the lifetime of the Session.
- **Resume-safe.** Every subscription accepts a resume cursor
  (`Last-Event-ID` for SSE, `seq` for WS). The agent replays from the cursor
  and no event is silently dropped between disconnect and reconnect.
- **Independent projections.** PTY, Conversation, State, Files, and Summary
  are five projections of the same Session. None is derived from another. If a
  UI feature needs data from a second projection, the Session is missing an
  event — **add the event, never the heuristic**.

## API Freeze Rule (M3)

> **No new Session fields may be added after Phase 5** unless they are required
> to fix a **verified bug** found during Phase 6 (acceptance test) or Phase 7
> (dogfood).

Mission Engine, the Runtime SDK, notifications, and future automation depend on
this API being stable. Treat the Session API the same way the wire protocol is
treated — additive changes only, and only for cause.

## The rule is the discipline

Every future change to Runtime asks the same two questions:

1. Which projection does this belong to?
2. Which event does it subscribe to?

If either answer is "a new one," update this document in the same PR.
