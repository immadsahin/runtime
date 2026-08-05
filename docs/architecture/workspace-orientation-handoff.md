# Handoff — Runtime Workspace orientation prompt

Small, self-contained feature: inject a minimal Runtime **orientation system
prompt** into Claude when a Workspace Session starts — the analog of Conductor's
"you are working inside X" prompt. Orientation only; not engineering opinions.

## Why

When `runtime-agent` launches Claude today it's bare:
`claude --permission-mode bypassPermissions` (`runtime-agent/internal/claude/claude.go`).
Claude has no idea it's inside a Runtime Workspace — which branch/worktree it's on,
that the session persists across disconnects, or that its work becomes a PR. A tiny
orientation prompt fixes that and establishes the **prompt-layering seam** the
Mission Engine will later build on.

## Design

**Append, don't replace.** Use Claude Code's `--append-system-prompt` so we augment
Claude's defaults *and* the repo's auto-loaded `CLAUDE.md` instead of fighting them
(DRY — don't restate repo conventions).

The layering this establishes (build to it):
```
1. Runtime orientation   ← --append-system-prompt   (where you are + the rules)   ← THIS TASK
2. Repo CLAUDE.md        ← Claude Code auto-loads    (project conventions)
3. Owner instructions    ← optional, future          (user global prefs)
4. Task / Mission prompt ← the request               (Mission Engine, later)
```
Runtime's prompt is the **floor, not a ceiling** — repo/owner/task layers override.

### Prompt content (orientation + rules ONLY)
Keep it short. Template it from the workspace facts:
```
You are running inside a Runtime Workspace: an isolated git worktree on branch
`<branch>`, based on `<baseBranch>`, inside a persistent cloud computer.

- Your session persists. The user may disconnect and reconnect; keep working.
- Your changes stay on this branch and are published as a pull request. Do not
  switch branches or push to the base branch.
- Other workspaces are isolated from yours.
- Follow this repository's CLAUDE.md and conventions.
```

### Explicitly OUT of scope
- Coding-style / process opinions → belong in `CLAUDE.md`, not here.
- The task itself → user prompt / Mission phase prompt (layer 4).
- Owner-instruction injection (layer 3) → future.
- Secrets, tokens, anything large.

## Implementation

- `runtime-agent/internal/claude/claude.go`: add `--append-system-prompt <text>` to
  `Command()` (and `ContinueCommand()` for consistency). Add a
  `Orientation(branch, baseBranch string) string` builder.
- Thread the workspace facts in: `Command()` needs `branch`/`baseBranch`, which live
  in `workspace/service.go` `Start`/`Resume`. This is the one **coordination point**
  (see below).
- Keep the prompt construction pure + unit-tested.

**Acceptance:**
- `Orientation()` renders the branch/base and the four rules; unit test covers it.
- Launcher argv includes `--append-system-prompt` with the rendered text.
- `cd runtime-agent && go build ./... && go vet ./... && go test ./...` green.
- Manual (real box, once M3 terminal exists or via raw WS): start a session, ask
  Claude "where are you running?" → it reflects the Runtime Workspace + branch.

## Coordination (parallel-work note)

M3 (agent 1) and M4-foundations (agent 2) are in flight. This task touches:
- `runtime-agent/internal/claude/claude.go` — **isolated, low risk** (no one else edits it).
- `runtime-agent/internal/workspace/service.go` `Start`/`Resume` — **shared**: M4's
  cast tee-hook also touches this file, and M3 may touch the start flow. Keep the
  edit to the minimal change needed to pass `branch`/`baseBranch` into `Command()`,
  and flag it so it's not a merge surprise. Ideal merge order: land this small
  change early, or after M4-foundations, to minimize churn in `service.go`.

Do **not** touch `app/**`, `components/**`, `server.go` `/events`, or
`workspace_status` — those are M3/M4 territory.

## Pointers
- Launcher: `runtime-agent/internal/claude/claude.go`
- Caller: `runtime-agent/internal/workspace/service.go`
- Agent detail: [`runtime-agent.md`](./runtime-agent.md)
- Where the layering pays off: [`mission-engine-v0.md`](./mission-engine-v0.md) (phase prompts sit at layer 4 on top of this orientation)
- Progress: [`PROGRESS.md`](./PROGRESS.md)
