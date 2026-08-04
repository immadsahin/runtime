# Runtime Agent Protocol (language-agnostic)

The wire contract between Next.js (control plane) and `runtime-agent` (data plane), and between
the browser and the agent's PTY socket. It is **language-agnostic**: the Go v1 agent and any
future agent implement the same messages. The canonical, runtime-validated definition is
`lib/runtime/agent-protocol.ts` (zod schemas); agent-side structs mirror it, and **golden JSON
fixtures** are validated by both sides in CI to prevent drift.

## Transport & auth

Two callers, two paths — both reach the agent through Daytona preview URLs:

- **Browser → agent (data plane, WSS).** Uses a Daytona **signed** preview URL (Daytona token
  embedded in the URL, because browsers cannot set the `x-daytona-preview-token` header on a WS
  handshake). The URL also carries `?token=<Runtime JWT>` (5-min TTL) that the agent verifies.
- **Next → agent (control plane, HTTPS).** Uses the **standard** preview URL + the
  `x-daytona-preview-token` header, plus a layered Runtime token bound to the computer.

Runtime JWT claims (minted by Next after verifying the Supabase session + project ownership):

```json
{ "workspaceId": "…", "projectId": "…", "computerId": "…", "userId": "…", "exp": 300 }
```

The agent validates: signature, expiry, and that `workspaceId`/`computerId` match what it hosts.
On expiry the browser re-mints via a Next token endpoint and reconnects to the **same** tmux.

## PTY socket messages (WS /pty)

Client → agent:
- `{ "t": "input", "data": "<utf8>" }` — keystrokes (only honored from the single writer).
- `{ "t": "resize", "cols": <n>, "rows": <n> }`
- `{ "t": "ping" }`

Agent → client:
- `{ "t": "output", "data": "<bytes>", "seq": <n> }` — coalesced terminal output (redacted).
- `{ "t": "role", "writer": <bool> }` — whether this connection holds the keyboard.
- `{ "t": "exit", "code": <n> }` — the Claude/PTY process exited (offer resume).
- `{ "t": "pong" }`

## Control messages (HTTP, see runtime-agent.md for routes)

Requests and responses are JSON validated against the shared schemas. Errors use a stable shape:

```json
{ "error": { "code": "WORKSPACE_NOT_FOUND | UNAUTHORIZED | AGENT_UNREACHABLE | …", "message": "…" } }
```

## Conversation events (agent → Next/browser)

Derived by the ConversationWatcher from Claude Code's session JSONL. **Not** parsed from the PTY.
Grounded in the real schema (Spike 3, Claude Code 2.0.24):

- `ConversationMessage`
  ```json
  { "t": "message", "uuid": "…", "parentUuid": "…|null", "role": "user|assistant",
    "timestamp": "…", "content": [ /* blocks below */ ] }
  ```
- Content blocks: `text`, `thinking`, `tool_use` (`{ "id", "name", "input", "caller" }`),
  `tool_result` (`{ "toolUseId", "content" }`).
- `TokenUsage`
  ```json
  { "t": "usage", "input_tokens": n, "output_tokens": n,
    "cache_creation_input_tokens": n, "cache_read_input_tokens": n, "service_tier": "…" }
  ```

**Parser rules (defensive — the JSONL format is internal, undocumented, `version`-tagged):**
- Whitelist rendered record types (`user`, `assistant`); **ignore** app-internal types
  (`queue-operation`, `attachment`, `ai-title`, `last-prompt`, `mode`, `pr-link`, `system`, …).
- Tolerate unknown record types and unknown object keys without failing.
- Tail incrementally by byte offset; buffer a partial trailing line until its newline arrives.
- Handle session rotation (`claude --continue` may open a new `<uuid>.jsonl`).
- Pin/track the Claude Code version installed on the box; re-validate fixtures on upgrade.
