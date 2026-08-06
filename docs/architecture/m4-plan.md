# M4 Design — the Workspace Snapshot (Archive / Replay / Restore)

> **Workspace Snapshot is Runtime's persistence abstraction.** Replay, Restore,
> Mission Engine, analytics, and future branching must consume Snapshot artifacts
> **through the manifest**, never by directly reading storage objects.

Design for **Milestone 4**, the durable persistence of a Workspace Session. Read
[`m3-handoff.md`](./m3-handoff.md) first — M4 operates on the **Workspace Session**
M3 defines, and produces the **Workspace Snapshot** everything downstream builds on.

## Status

- **Design:** ✅ Frozen (open decisions flagged below — confirm before building)
- **Implementation:** ✅ Complete. Archive, replay, and restore vertical slices
  are implemented and locally verified; authenticated real-Daytona acceptance
  remains pending. The canonical current status is
  [`PROGRESS.md`](./PROGRESS.md).

## One durable abstraction per milestone

M4 continues the pattern: each milestone introduces one foundational object that
higher-level features naturally build on.

```
M2 → Runtime Computer   M3 → Workspace Session   M4 → Workspace Snapshot   → Mission Engine
```

## What already exists (don't rebuild)

Grounded in `main`:
- **Agent** (`runtime-agent/internal/workspace/service.go`): `Create` (idempotent
  worktree add), `Start` (tmux + Claude), `Stop`, **`Resume` (relaunch with
  `claude --continue`)**, `Archive` (endpoint — teardown only today).
- **Protocol**: `WorkspaceStateChanged` already includes an **`archived`** state.
- **Lifecycle** (`app/api/workspaces/[id]/lifecycle/route.ts`): `suspend` / `resume`
  / `destroy` (no `archive` yet).

Missing (M4 builds it): PTY **cast capture**, **object storage**, the Snapshot
**manifest + object model**, the **`archived` workspace_status**, and
archive/replay/restore orchestration.

## The core abstraction: Workspace Snapshot

A **Workspace Snapshot** is a **first-class, immutable object** — not a folder of
files. It is addressed entirely through its **manifest**:

```
Workspace Snapshot
 ├── Manifest      (the contract — read this, nothing else enumerates storage)
 ├── Conversation  (JSONL)
 ├── Terminal      (asciinema cast)
 ├── Git / Tree    (filesystem capture, behind an interface)
 └── Summary       (WorkspaceSummary)
```

Rules:
- **Immutable.** Never edit, overwrite, or mutate a Snapshot. If we later support
  multiple save points they are **Snapshot A / B / C**, never "Snapshot → updated."
- **Manifest is the only entry point.** Every consumer (Replay, Restore, Mission,
  analytics) reads `manifest.json` and follows its pointers. Nothing lists a bucket
  prefix. This keeps features decoupled from storage layout.
- **Archive** is the *action* that produces a Snapshot; **Replay / Restore / (future)
  Fork** are its *consumers*.

### The manifest (the contract)

```jsonc
{
  "version": 1,
  "workspaceId": "...",
  "runtimeVersion": "...",
  "claudeVersion": "...",
  "sessionId": "...",              // for `claude --continue`

  "conversation": "conversation.jsonl",
  "cast": "session.cast",
  "tree": { "kind": "git-bundle+patch", "bundle": "worktree.bundle", "patch": "uncommitted.patch" },
  "summary": "summary.json",

  "checksums": { "...": "sha256:..." },
  "sizes": { "...": 12345 },

  "startedAt": "...",
  "archivedAt": "...",

  "lastCommit": "...",
  "lastMessage": "...",
  "tokenUsage": { "...": 0 },
  "changedFiles": 14
}
```

### The Tree is an interface, not a format

The filesystem capture is behind an interface so callers restore through it, not the
format. **Today:** `git bundle` (committed) + `uncommitted.patch`. **Tomorrow
(possible):** OCI layer, ZFS snapshot, filesystem image. `manifest.tree.kind`
declares the impl; Restore dispatches on it. Mission/Replay never care.

## Workspace Summary (frozen now — Mission depends on it)

The Summary is an API, so freeze its shape rather than leaving it vague:

```ts
type WorkspaceSummary = {
  state: WorkspaceState;
  startedAt: string;
  endedAt: string | null;
  duration: number;            // seconds
  lastActivity: string;
  tokenUsage: TokenUsage;
  changedFiles: number;
  filesTouched: string[];
  commitCount: number;
  lastAssistantMessage: string | null;
};
```

Emitted live during a Session (M3) and snapshotted into the manifest at archive.

## Concepts (keep these distinct)

| Term | Compute | Storage | Meaning |
| --- | --- | --- | --- |
| **Suspend** (exists) | released | worktree stays on the box | Warm pause; fast `resume`. |
| **Archive** (M4) | released; worktree reclaimable | **produces a Snapshot** | Cold, durable, box-independent. |
| **Replay** (M4) | **none — browser only** | reads the Snapshot | Read-only playback of cast + conversation + diff. |
| **Restore** (M4) | fresh box (any) | rebuilt from the Snapshot | Revive an archived Session (`claude --continue`). |
| **Destroy** (exists) | removed | Snapshot removed too | Permanent. |
| **Fork** (future) | fresh box | branches from a Snapshot | Not v0 — but the reason Snapshots are immutable. |

> Two "resume" paths: lifecycle `resume` revives a **suspended** workspace; M4
> **restore** revives an **archived** one from a Snapshot. Name them distinctly.

## Invariants

1. **A Snapshot is immutable and manifest-addressed.** No consumer enumerates storage.
2. **Replay never requires Runtime.** No Runtime Computer, no runtime-agent, no tmux,
   no Claude — **browser + storage only.** (A headline feature, and a hard boundary.)
3. **The cast is recorded server-side by the agent, from session start** — independent
   of any browser connection.
4. **Restore reconstructs exact WIP** (committed *and* uncommitted) and is verified
   before Claude boots (below).
5. **Archive and restore are idempotent.**
6. **Conversation and terminal remain independent projections** (M3 invariant).

## State machine additions

Add to `workspace_status`: **`archiving`**, **`archived`**, **`restoring`**.

```
ready/idle ─archive─▶ archiving ─▶ archived
archived   ─restore─▶ restoring ─▶ ready
archived   ─destroy─▶ destroying ─▶ destroyed   (also deletes the Snapshot)
```

## Flows

**Archive (produce a Snapshot):** mark `archiving` → stop Claude, flush JSONL,
finalize the cast → build the Tree (bundle + patch) → snapshot the Summary →
compute checksums/sizes → write `manifest.json` **last** (its presence means the
Snapshot is complete) → upload → reclaim worktree/tmux → mark `archived`.

**Replay (browser + storage only):** read `manifest.json` → play `cast`, render the
Conversation Timeline from `conversation.jsonl`, show the diff from the Tree. No box.

**Restore:** mark `restoring` → ensure a Runtime Computer (**any**, not necessarily
the original) → materialize the Tree (apply bundle + patch) → **verify** →
`Start`/`Resume` with `manifest.sessionId` (`claude --continue`) → mark `ready`.

> **Restore verification (never boot Claude into a broken restore):** bundle
> applied ✓ · patch clean ✓ · `git status` clean/expected ✓ · `sessionId` present ✓.
> Any failure → abort restore with a clear error; do not launch Claude.

## Retention (concept only — not v0 implementation)

Every Snapshot carries an **Archive Policy**: `keep_forever` · `delete_after_n_days`
· `manual_only`. v0 ships `manual_only`, but the field exists so we never
implicitly commit to infinite storage.

## Open decisions (resolve before implementation)

1. **Who uploads artifacts?** *Rec: the agent uploads via a short-lived signed
   upload URL minted by Next* (keeps large binaries off the control plane).
2. **Snapshot metadata shape?** *Rec: a `workspace_snapshots` table* (owner-scoped;
   pointers + `manifest` jsonb + policy), which also enables Snapshot A/B/C later.
3. **Tree impl for v0?** *Rec: `git bundle` + uncommitted patch*, behind the Tree
   interface (`manifest.tree.kind`).
4. **Storage backend?** *Rec: Supabase Storage* (signed URLs + RLS; no new system).
5. **Cast capture always-on?** *Rec: agent records from session start.*
6. **Auto-archive?** *Rec: manual only for v0.*

## Out of scope for v0

Fork/branching · auto-archive scheduling · multi-point history UI · cross-project
restore · compression tuning · cast editing · partial restore.

## Acceptance Test

`pnpm check`, then against a **real box**:
1. Active Session with edits + conversation.
2. **Archive** → Claude stopped, Snapshot produced (manifest written last), status
   `archived`, worktree reclaimed.
3. **Replay** → cast plays, Timeline renders, diff visible.
4. **Restore** → Tree materialized, verification passes, `claude --continue` resumes
   the *same* session, terminal live.
5. **Idempotency** → re-archive / re-restore safe.
6. **Destroy** an archived workspace removes its Snapshot.
7. **Replay works while the Runtime Computer is completely destroyed** (proves
   Snapshots are box-independent).
8. **Restore onto a *different* Runtime Computer** than the original (proves
   portability).

### Data-plane verifier

`scripts/verify-daytona-m4.ts` turns the archive / portability / idempotency
portions of this checklist into a credential-gated executable run. It creates a
real Claude session, writes both a committed and uncommitted change, archives
through the agent into all six signed Supabase upload URLs, destroys the source
Runtime Computer, validates every manifest-addressed artifact checksum and size
from Storage alone, restores onto a fresh Runtime Computer, and restores again
to prove idempotency. It deliberately does not stand in for the authenticated
Next/browser acceptance (Timeline, Replay UI, lifecycle state transitions, and
Publish still require the complete M3/M4 manual flow).

```sh
./scripts/build-agent.sh
pnpm verify:daytona:m4
```

It requires `DAYTONA_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and one of `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY` in `.env.local`. It cleans up both test computers and every
object it uploaded even on failure. Optional `VERIFY_REPO`, `VERIFY_BASE`,
`GITHUB_PAT`, and `VERIFY_OWNER_ID` follow the script header.

Record it like the prior spikes (short report under `docs/architecture/`).

## Dependencies & downstream

- **Depends on M3:** Workspace Session, conversation `/events`, Workspace Summary.
- **Feeds:** [`mission-engine-v0.md`](./mission-engine-v0.md) consumes the `archived`
  state event + the Snapshot's Summary (via manifest). Also the foundation for future
  analytics, sharing, and Fork. Completes the full-loop DoD in
  [`PROGRESS.md`](./PROGRESS.md).

## Pointers
- M3 surface + Session model: [`m3-handoff.md`](./m3-handoff.md)
- Protocol / agent: [`protocol.md`](./protocol.md), [`runtime-agent.md`](./runtime-agent.md)
- Progress: [`PROGRESS.md`](./PROGRESS.md)
