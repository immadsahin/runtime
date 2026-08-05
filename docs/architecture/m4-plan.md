# M4 Design — Archive / Replay / Restore

Design for **Milestone 4**, the cold lifecycle of a Workspace Session. Read
[`m3-handoff.md`](./m3-handoff.md) first — M4 operates on the **Workspace Session**
abstraction M3 defines.

## Status

- **Design:** ✅ Frozen (open decisions flagged below — confirm before building)
- **Implementation:** 🚫 Blocked on **M3** (needs the Workspace Session, conversation
  event channel, and Workspace Summary).

## What already exists (don't rebuild)

Grounded in `main`:
- **Agent** (`runtime-agent/internal/workspace/service.go`): `Create` (worktree add,
  idempotent), `Start` (tmux + Claude), `Stop` (ends Claude, keeps worktree),
  **`Resume` (kills session, relaunches with `claude --continue`)**, `Archive`
  (endpoint exists — currently tmux/worktree teardown only).
- **Protocol** (`agent-protocol.ts`): `WorkspaceStateChanged` already includes an
  **`archived`** state.
- **Lifecycle** (`app/api/workspaces/[id]/lifecycle/route.ts`): handles
  `suspend` / `resume` / `destroy` (no `archive` yet).

What's **missing** (M4 builds it): PTY **cast capture**, **object storage** for
artifacts, the **`archived` workspace_status**, and the archive/restore/replay
orchestration.

## Concepts (keep these distinct)

| Term | Compute | Storage | Meaning |
| --- | --- | --- | --- |
| **Suspend** (exists) | released | worktree stays on the box | Warm pause; fast `resume` onto the same/fresh compute. |
| **Archive** (M4) | released; worktree reclaimable | **artifacts → object storage** | Cold, durable, **box-independent** end of a Session. Read-only. |
| **Destroy** (exists) | removed | removed (incl. archive) | Permanent. |
| **Replay** (M4) | none needed | reads artifacts | Read-only playback of cast + conversation from storage. |
| **Restore** (M4) | fresh box | rebuilt from artifacts | Bring an *archived* Session back to life (`claude --continue`). |

> Note the two "resume" paths: existing lifecycle `resume` revives a **suspended**
> workspace; M4 **restore** revives an **archived** one from cold artifacts. Name
> them distinctly in code to avoid confusion.

## Artifacts (the archive bundle)

Per workspace, in a private object-storage bucket:

| Artifact | Format | Powers |
| --- | --- | --- |
| `session.cast` | asciinema v2 | Terminal replay |
| `conversation.jsonl` | Claude session JSONL | Conversation Timeline replay **+ the session id for `--continue`** |
| `worktree.bundle` | `git bundle` (committed) + `uncommitted.patch` | Exact WIP reconstruction on restore |
| `summary.json` | Workspace Summary snapshot | Mission Engine (consumes Summary, not raw conversation) |
| `manifest.json` | versions, sizes, checksums, session id, timestamps | Integrity + restore metadata |

**Storage layout:** `archives/{owner_id}/{workspace_id}/{archived_at}/…` in a
private, owner-scoped bucket.

## Invariants

1. **Artifacts are the source of truth for a cold Session.** Replay never needs a box.
2. **The cast is recorded server-side by the agent, from session start** — independent
   of whether a browser is connected (so unattended sessions are still replayable).
3. **Restore reconstructs exact WIP** (committed *and* uncommitted changes).
4. **Archive and restore are idempotent** (Runtime's reconciliation philosophy).
5. **Conversation and terminal remain independent projections** (M3 invariant carries
   over — replay renders both from artifacts, neither derived from the other).

## State machine additions

Add to `workspace_status`: **`archiving`**, **`archived`**, **`restoring`**
(migration). Transitions:

```
ready/idle ──archive──▶ archiving ──▶ archived
archived ──restore──▶ restoring ──▶ ready
archived ──destroy──▶ destroying ──▶ destroyed   (also deletes artifacts)
```

`archived` and `restoring` emit `WorkspaceStateChanged` events (Status projection).

## Flows

**Archive** (new lifecycle action → agent):
1. Mark `archiving`. 2. Agent: stop Claude, flush the session JSONL, finalize
`session.cast`. 3. Build `worktree.bundle` + `uncommitted.patch`; snapshot
`summary.json`. 4. Upload all artifacts + `manifest.json`. 5. Reclaim the worktree
+ tmux on the box. 6. Mark `archived`, persist archive pointers.

**Replay** (read-only, no box): fetch artifacts → play `session.cast` in xterm,
render the Conversation Timeline from `conversation.jsonl`, show the diff from the
bundle. Pure client + storage.

**Restore**: mark `restoring` → ensure a Runtime Computer → recreate the worktree
from `worktree.bundle` + apply `uncommitted.patch` → `Start`/`Resume` with the
stored session id (`claude --continue`) → mark `ready`. Terminal + conversation go
live again.

## Open decisions (resolve before implementation)

1. **Who uploads artifacts?** *Rec: the agent uploads directly via a short-lived
   signed upload URL minted by Next.* Keeps large binaries off the control plane;
   Next never proxies big files. (Alt: control-plane pulls from the agent.)
2. **Archive metadata shape?** *Rec: a `workspace_archives` table* (owner-scoped,
   pointers + `manifest` jsonb) mirroring the `pull_requests` one-per-workspace
   pattern, leaving room for multiple archive points later. (Alt: columns on
   `workspaces`.)
3. **WIP capture?** *Rec: `git bundle` (committed) + an uncommitted patch.* (Alt:
   full worktree tarball — simpler, heavier; or require-commit-before-archive —
   loses WIP.)
4. **Storage backend?** *Rec: Supabase Storage* (consistent with the stack, RLS,
   signed URLs). (Alt: S3/R2 if size/egress later demands it.)
5. **Cast capture always-on?** *Rec: agent records from session start*, not only
   while a browser is connected.
6. **Auto-archive on idle?** *Rec: manual only for v0*; auto-archive-on-idle later.

## Out of scope for v0

Auto-archive scheduling · multi-point snapshot history · cross-project restore ·
compression tuning · cast editing/trimming · partial restore.

## Acceptance Test

`pnpm check`, then against a **real box**:
1. Active Session with edits + conversation.
2. **Archive** → Claude stopped, artifacts uploaded, status `archived`, worktree reclaimed.
3. **Replay with no live box** → cast plays, Conversation Timeline renders, diff visible.
4. **Restore** → worktree reconstructed with WIP intact, `claude --continue` resumes the
   *same* session, terminal live again.
5. **Idempotency** → re-archive / re-restore are safe no-ops where appropriate.
6. **Destroy** an archived workspace also removes its artifacts.

Record it like the prior spikes (short report under `docs/architecture/`).

## Dependencies & downstream

- **Depends on M3:** Workspace Session, conversation `/events`, Workspace Summary.
- **Feeds Mission Engine:** the `archived` state event + Workspace Summary are exactly
  what [`mission-engine-v0.md`](./mission-engine-v0.md) consumes. M4 completes the
  full-loop DoD (archive → restore) in [`PROGRESS.md`](./PROGRESS.md).

## Pointers
- M3 surface + Session model: [`m3-handoff.md`](./m3-handoff.md)
- Protocol / agent: [`protocol.md`](./protocol.md), [`runtime-agent.md`](./runtime-agent.md)
- Progress: [`PROGRESS.md`](./PROGRESS.md)
