# Spike / Build Report — M2 pt2: DaytonaRuntimeProvider + lazy provisioning + agent deploy

**Date:** 2026-08-05 · **Status:** ✅ verified on a real Daytona box, pre-commit
· **Snapshot:** `runtime-computer-v1` · **Repo under test:** `octocat/Hello-World`

This continues the Runtime pattern (**Design → Spike → Measure → Decide → Build**).
The open decision going in was the agent-deploy story; it was resolved by measuring
a real box, then hardening the path the measurement exposed.

---

## 1. What shipped

- **`DaytonaRuntimeProvider`** (`lib/runtime/daytona-provider.ts`) — Runtime's real
  compute model: one always-on box per project. Honest surface is the **Runtime
  Computer lifecycle** (`provisionComputer` / `computerAlive` / `destroyComputer` /
  `agentTarget` / `fetchMirror`); workspace/session ops go through `AgentClient`.
  The Modal-shaped `RuntimeProvider` methods throw — batch/SSE with the retirement
  message (deleted in pt3), the rest pointing at the `AgentClient` path.
- **Agent deploy** (`lib/runtime/daytona/deploy.ts`) — decision **1A + gzip**:
  gzip → upload → gunzip → chmod → launch-detached → poll `/health`. Split into
  timeable primitives (`uploadAgent` / `bootAgent` / `waitForAgentHealth`).
- **Bare mirror via the shared git module** — seeded at provision so worktrees can
  branch immediately.
- **`runtime_computers` repository** (`lib/db/repositories.ts`) — first-class CRUD,
  race-safe create on the `unique(project_id)` gate, server-only secret read.
- **Provisioning instrumentation from day one** — every stage timed
  (`ProvisionTimer`) and persisted to `runtime_computers.provision_timings` (jsonb).
- **Wiring** — `RUNTIME_PROVIDER=daytona`, env keys, `.env.example`.
- **Verify harness** — `scripts/verify-daytona.ts` drives the shipping code paths
  end-to-end on a real box; `scripts/build-agent.sh` cross-compiles the binary.

---

## 2. Timings (real box, gzip'd upload)

| Stage            |    ms | Notes                                                    |
|------------------|------:|----------------------------------------------------------|
| `sandbox_create` | 2 585 | from the frozen `runtime-computer-v1` snapshot           |
| `agent_upload`   | 6 782 | **gzip'd** 6.42 MB → 2.69 MB (2.4×)                       |
| `agent_boot`     | 1 666 | gunzip + chmod + launch (async session — see §4.1)       |
| `health_check`   |   918 | first loopback `/health` 200                             |
| `mirror_clone`   | 1 593 | `octocat/Hello-World` (tiny; scales with repo size)      |
| **TOTAL**        | **15 467** | create → live agent + seeded mirror in ~15 s        |

**Bottleneck:** upload, as predicted. gzip alone took it from the spike's ~38 s
(uncompressed 6.4 MB) to ~7 s. That validated **not** building a release-download
pipeline now — the remaining cost is a one-time, per-project operation, and it
disappears entirely when the agent is baked into `runtime-computer-v2`.

End-to-end after provisioning: `createWorkspace` (worktree off `origin/master`) →
`startWorkspace` (tmux) → **WS `/pty` over the signed preview URL streamed real PTY
bytes through the Runtime-token handshake + tmux attach** → `stopWorkspace` →
auto-destroy (no orphan box). Live Claude output was not re-proven here (no Claude
token in this run) — that was Spike 4; this spike proves the new integration.

---

## 3. Architecture

```
Project ──1:1──> Runtime Computer (Daytona box, always-on)
                    │  runtime-agent :8080 (uploaded on provision)
                    │  repo.git (bare mirror, refs/remotes/origin/*)
                    └──1:N──> Workspace = worktree + tmux session (Claude)

control plane (Next):  AgentClient ──HTTPS──> preview URL (+ preview token + Runtime JWT)
browser terminal:      xterm.js ──WSS──> signed preview URL (token in host) + Runtime JWT
```

This is **not** Modal's workspace-per-sandbox shape. The provider reflects that
directly instead of forcing Daytona through the old interface; pt3 removes the
Modal-shaped assumptions (retires the batch path, moves git/session ops off the
`RuntimeProvider` interface).

---

## 4. Bugs the real-box run surfaced (and fixes)

### 4.1 `agent_boot` hung forever on a successful boot
The agent launched fine (`listening on :8080`, `/health` 200), but
`provisionComputer` never returned. Daytona's **synchronous `executeCommand` does
not return while the daemon it started keeps running** — `setsid … < /dev/null &`
with redirected fds was not enough. The SDK's default request timeout is ~24 h, so
the call would have blocked essentially forever.
**Fix:** launch the daemon through a background **session** with `runAsync: true`
(`BoxIO.launch`), which returns immediately. Prep (gunzip/chmod) stays synchronous
so its failures still surface.

### 4.2 `cloneMirror` produced refs the agent could not branch from
`git clone --bare` puts branches in `refs/heads/*`, but the agent creates worktrees
off `origin/<base>`; result: `fatal: invalid reference: origin/master`. The bare
mirror and the agent's worktree command did not compose.
**Fix:** `cloneMirror` now builds a proper remote-tracking mirror
(`init --bare` → `remote add origin` → `fetch +refs/heads/*:refs/remotes/origin/*`),
so `origin/<base>` resolves and the only local `refs/heads` are workspace branches.
`fetchMirror` reuses the refspec `remote add` configured.

Both were found **only** because the verification drives the real, integrated path —
exactly the argument for measuring before assuming.

---

## 5. Lessons

- **A green unit suite says nothing about a cloud SDK's blocking semantics.** The
  boot hang was invisible to types and mocks; a real box found it in one run.
- **Detach ≠ returns.** On Daytona, "long-running background process" means the
  async session API, not shell backgrounding.
- **Cross-boundary contracts drift silently.** The git module (refs/heads) and the
  Go agent (origin/*) each looked correct in isolation.
- **Don't pipe a long verify through `tail`** — it withholds all output until exit
  and turned a diagnosable hang into a black box. Write to a log and watch it.
- **Instrumentation paid off immediately:** the per-stage table located the hang to
  `agent_boot` without a debugger.

---

## 6. Recommendations / follow-ups

- **pt3:** delete the retired batch methods; move git/session ops off the
  `RuntimeProvider` interface; wire the DB-orchestrated lazy-provision
  (`ensureRuntimeComputer`: read row → race-safe create → `provisionComputer` →
  persist sandbox id / base URL / timings) — not e2e-tested here because it needs an
  authenticated Supabase session.
- **v2 image:** bake the stabilized agent into `runtime-computer-v2` and delete the
  entire upload path (`deploy.ts`, `build-agent.sh`, `RUNTIME_AGENT_BINARY_PATH`).
- **Secret delivery:** this spike injects project secrets into the agent's launch
  env (in memory, none at rest). A dedicated "deliver secrets" step should replace
  the boot-env channel when sessions need per-workspace secrets.
- **Watch:** `mirror_clone` scales with repo size; large repos will dominate the
  provision budget. The `provision_timings` column will show it if it regresses.
- **Housekeeping:** rotate the shared `CLAUDE_CODE_OAUTH_TOKEN` (still treated as
  exposed); `provision_timings` migration applied.
