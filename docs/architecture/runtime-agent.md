# runtime-agent

The daemon that runs on each Runtime Computer (Daytona Ubuntu box). It is the **data plane**:
it owns everything local to the box. Next.js (the **control plane**) never SSHs into the box —
it talks only to the agent, and only the agent talks to Claude, git, tmux, and the filesystem.

**v1 implementation:** Go (single static binary; see rationale in
[`runtime-v1-plan.md`](./runtime-v1-plan.md)). The [`protocol`](./protocol.md) is language-agnostic.

## Trust model

- The agent trusts **only signed Runtime tokens** minted by Next. It knows nothing about GitHub
  OAuth, Supabase sessions, or browser cookies.
- Reachability is via Daytona preview URLs (see [`protocol.md`](./protocol.md#transport--auth)).
- Project secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) are delivered by Next at provision time,
  held **in memory only**, injected into each Claude session's environment, never written to disk.

## HTTP control API

Called server-to-server by Next (never by the browser). All requests carry a Runtime token.

| Method & path | Purpose |
|---|---|
| `POST /workspaces` | Create a workspace: `git worktree add` + branch, prepare env. |
| `POST /workspaces/:id/start` | Launch Claude Code in a fresh tmux session + PTY. |
| `POST /workspaces/:id/stop` | Stop the Claude session (leave worktree intact). |
| `POST /workspaces/:id/archive` | Kill tmux, finalize cast + JSONL, mark read-only. |
| `POST /workspaces/:id/restore` | Recreate tmux + PTY, `claude --continue`. |
| `DELETE /workspaces/:id` | Remove worktree + tmux for the workspace. |
| `GET  /workspaces/:id/events` | Server-sent control/conversation events (see Event types). |
| `GET  /health` | Liveness + basic load (drives `runtime_computers.status`, `last_active_at`). |

## WebSocket

| Path | Purpose |
|---|---|
| `WS /pty?token=…` | Bidirectional terminal for one workspace. Browser connects **directly** via a Daytona signed preview URL; the `?token=` is the 5-min Runtime JWT the agent verifies (workspace/computer binding). One **writer**; additional attachers are **read-only**. |

Streaming rules (perf): PTY output is **coalesced on a ~16–33ms flush** and subject to
**backpressure** — if a client's send buffer fills, the agent pauses reading the PTY (flow control)
so one slow browser can't exhaust the shared box. Redaction runs on the batched buffer with a
carry window for secrets spanning chunk boundaries.

## Internal services

- **GitService** — bare mirror + `fetch`; `worktree add/remove`; status/diff/commit/push/askpass.
  Mirrors the shared `lib/runtime/git/` logic (same behavior, agent-side exec).
- **WorkspaceService** — workspace lifecycle on the box; maps workspace → worktree path → tmux session.
- **PTYService** — allocate/attach/resize/close PTYs; enforce one-writer; record asciinema cast.
- **ClaudeService** — launch `claude` / `claude --continue` inside tmux with the session env.
- **ConversationWatcher** — incremental byte-offset tail of `~/.claude/projects/<hash>/*.jsonl`;
  whitelist rendered record types; emit structured deltas; handle partial-line writes + session rotation.
- **ArchiveService** — finalize + upload cast + JSONL to object storage; mark workspace read-only.

## Event types (agent → Next/browser)

- `PTYOutput` — terminal bytes (coalesced) for a workspace.
- `PTYInput` — keystrokes from the writer client (browser → agent).
- `ConversationMessage` — a structured turn derived from JSONL (role + content blocks).
- `ToolCall` — `tool_use` / `tool_result` pair (name, input, result).
- `TokenUsage` — assistant `usage` deltas (input/output/cache tokens).
- `WorkspaceStateChanged` — lifecycle transitions (starting/running/archived/degraded).
- `GitChanged` — changed-file summary for the diff panel.

Concrete field shapes for these live in [`protocol.md`](./protocol.md), grounded in the real
Claude Code JSONL schema (Spike 3 findings).
