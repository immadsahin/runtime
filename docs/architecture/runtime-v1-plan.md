# Runtime v1 — Implementation Plan (Conductor replacement for Claude Code)

Canonical architecture for Runtime v1. Consolidated from the plan-mode review
(Architecture → Code Quality → Tests → Performance). Decisions below are **locked**.

Companion docs: [`runtime-agent.md`](./runtime-agent.md) (agent API/services/events),
[`protocol.md`](./protocol.md) (language-agnostic wire contract).

## Goal & scope

Smallest open-source Conductor replacement, **Claude Code only**, built **on top of** the
existing Next.js + TypeScript + Supabase codebase (do NOT rewrite it). A developer connects
GitHub, clicks New Workspace, Claude Code launches in a shared cloud Ubuntu box, watches it
live, closes the laptop, Claude keeps running, reconnects from any device, archives, and
resumes exactly where they left off.

In scope: Claude Code, existing auth/projects/GitHub, Daytona, git worktrees, one always-on
Runtime Computer per project, live PTY terminal, structured conversation view, archive/resume.
Out of scope (deferred, not deleted): Codex, multi-provider/agent abstractions, Redis, FastAPI,
suspend/snapshot/idle-shutdown, hostile multi-tenancy hardening.

## Locked decisions

**Product / infra**
- Keep existing Next.js + Supabase codebase; extend, don't rewrite.
- One **Runtime Computer** (Daytona Ubuntu box) per Project, **shared** across its workspaces.
- **Lazy provisioning**: no computer at project creation; created on first New Workspace; kept warm.
- **Always-on** for V1 via Daytona `autoStopInterval: 0`. Suspend/snapshot deferred.
- **Workspace = one Claude Code session**: own git worktree, branch, PTY, tmux session, conversation, context.
- Two independent streams: **PTY → xterm.js** (terminal, human takeover) and **Claude JSONL → conversation UI** (chat/tools/tokens). Conversation is NOT parsed from the PTY.

**Architecture (Section 1)**
- **1A** Data plane = `runtime-agent`; control plane = Next. Browser opens **WSS directly to the agent via a Daytona _signed_ preview URL** (Daytona token in URL — browsers can't set the `x-daytona-preview-token` header on a WS handshake), carrying a **5-min Runtime JWT** (`?token=`) the agent verifies (workspace/computer binding). Control ops (create/archive/resume/delete/PR/rename) go Next → agent via the standard preview URL + header + layered Runtime token. Agent trusts ONLY signed Runtime tokens — no GitHub/Supabase/cookie awareness.
- **2A** Keep `RuntimeProvider` for compute-lifecycle + git; model interactive sessions through a separate **`AgentClient`** (typed wrapper over the agent's HTTP/WS API). Don't bloat `RuntimeProvider` with PTY methods.
- **3A** New **`runtime_computers`** table (`project_id`, `daytona_sandbox_id`, `agent_base_url`, `agent_secret`, `status`, `last_active_at`), lazy-provisioned; workspaces gain `computer_id`, `tmux_session`, `agent_workspace_id`; add `'daytona'` provider value; extend `workspace_status` with interactive states.
- **4A** Archive = capture **PTY asciinema-style cast + Claude JSONL** to **Supabase Storage** (S3 later), DB stores pointers, worktree stays on the always-on box. Resume = replay cast into xterm, then attach live tmux via `claude --continue`.

**Code quality (Section 2)**
- **1A** Extract a provider-agnostic **`lib/runtime/git/`** module over an injected `exec(cmd)→{stdout,stderr,code}` capability; all git flows (status/diff/commit/push/askpass/**bare-mirror+worktree**) live once.
- **2A** Canonical **`lib/runtime/agent-protocol.ts`** with **zod schemas validated at the boundary**, mirrored by the agent's structs.
- **3A** Agent holds project secrets **in memory**, injects into each tmux/Claude **session env**, none at rest on the box; redaction still scrubs outbound.
- **4A** Retire the SSE `-p` batch execution path; reuse `compute.ts` reconciliation + one-active-session invariant for interactive sessions. One execution model.

**Tests (Section 3)**
- **1A** Agent tests with a **scripted fake `claude`** + **real tmux in CI**; assert attach/detach/**reattach**, resize, stdin, and **WS-kill-does-not-kill-process** survival.
- **2A** **Golden JSON fixtures** validated by both TS (zod) and the agent + one boot-the-agent e2e smoke.
- **3A** Control-plane: `runtime_computers` state-machine, JWT mint/verify (expiry/wrong-binding/tamper), one-active-session invariant, using a contract-validated fake `AgentClient`.
- **4A** Six failure-mode tests: reconnect-after-expiry reattaches same tmux; browser disconnect → Claude survives; Claude exit → `claude --continue` fresh PTY; two browsers → one writer/others read-only; box unreachable → degraded not lost; archive during active session.

**Performance (Section 4)**
- **1A** Coalesce PTY output on ~16–33ms flush + **backpressure/flow-control**; redaction on batched buffer with a carry window for secrets spanning boundaries.
- **2A** JSONL watcher: **incremental byte-offset tail** (reuse SSE log-offset pattern), parse appended lines, handle partial-line writes + session rotation on `--continue`.
- **3A** Single **joined query** for list views + hot-path indexes (`runtime_computers.project_id`, `workspaces.computer_id`, active-session partial index).
- **4A** Modest Daytona tier + **instrument `last_active_at`** now; defer idle-shutdown mechanism.

## Runtime Agent implementation language

**Runtime Agent v1 implementation: Go** — selected for deployment simplicity (a single static
binary dropped onto the Daytona box, no Node runtime/`node_modules`). This is an implementation
choice, **not** a rule that all agents must be Go. The [wire protocol](./protocol.md) is
**language-agnostic**: any future agent that speaks the protocol can replace or complement the Go one.

## Reuse map (from code recon, file:line)

- **Reuse as-is**: Supabase schema + RLS + workspace state machine (`supabase/migrations/`), reconciliation (`lib/runtime/compute.ts`), provider selection (`provider.ts`/`resolve.ts` — `resolve.ts:11` already anticipates a terminal route), GitHub REST (`lib/github/client.ts`), `redact.ts`, `jobs.session_id`.
- **Replace**: non-interactive execution (`agent.ts:44-74`, `local-provider.ts:174-209`, `modal-provider.ts:158-169`) → interactive Claude under tmux/PTY; SSE transport (`.../logs/route.ts`) → WebSocket.
- **Build net-new**: PTY + tmux + WS, JSONL watcher, Go agent, terminal + conversation UI (only a static mock exists at `workspace-studio.tsx:247-253`).
- **Factor**: duplicated git helpers across `local-provider.ts` / `modal-provider.ts` → shared module.

## Phase 0 — Validation spikes (GATE: do only these until every unknown is resolved)

Freeze the architecture only after these pass; then build Phase 1+ in order without redesigning.

**Spike 1 — WebSockets through a Daytona preview URL (HIGHEST PRIORITY).** ✅ **PASSED** (2026-08-04)
Success: Browser → WSS → Daytona reaches the agent; bidirectional; <100ms RTT; long-lived (>2h);
reconnect works. *If this fails, the transport architecture changes.* Requires Daytona creds.

### Spike 1 — findings (real Daytona sandbox, node ws echo server on port 8080)
- **WS upgrade works through the Daytona proxy** via `getSignedPreviewUrl(port)` — form
  `wss://{port}-{token}.daytonaproxy01.net`, **token in the subdomain, NO custom headers**
  (browser-compatible). Bidirectional echo + reconnect both succeeded.
- **Steady-state latency (warm socket, 50 pings, Mac→US proxy→sandbox):** avg **277ms**, p50 269,
  p90 319, p99 363, min 250, max 363 — tight, no stalls. Intra-sandbox baseline (no proxy) ~0.04ms,
  so the ~270ms is entirely network+proxy. Acceptable for an SSH-like interactive terminal; the
  <100ms target is not achievable cross-region through the proxy regardless of implementation.
- **Cold start:** first handshake ~1.4s and first few messages showed multi-second stalls that
  settle once warm → **pre-warm the WS on workspace open** and keep it alive.
- **Signed preview token TTL is short (~60s default):** a *new* connection after expiry gets 401,
  but an already-open socket survives token expiry (token checked only at handshake). → mint signed
  URLs with a longer expiry and refresh for reconnects (matches the 5-min Runtime JWT design).
- **Idle drops:** use app-level WS ping/keepalive; full >2h soak not yet run (follow-up).
- **Image gap:** the default Daytona snapshot has node + git + python but **no tmux** and the user is
  **not root** (`/root` unwritable; use `$HOME`/`/tmp`). → the **Runtime Computer needs a custom
  snapshot** with tmux + Claude Code (+ node) baked in; provisioning (Phase 3) must build/use it.
- SDK bonus: native PTY API (`createPty`/`connectPty`/`resizePtySession`) + `createSshAccess` exist —
  useful for Spike 2 and human-takeover.

**Spike 2 — PTY + tmux (on Ubuntu, not macOS).** ✅ **PASSED** (2026-08-04)
`Go → PTY → tmux → Claude → reconnect → attach`. Verify: multiple PTYs coexist; resize; UTF-8;
copy/paste; process-exit detection. Run on the Daytona box (macOS behavior is not a valid signal).

### Spike 2 — findings (sandbox from `runtime-computer-v1`, fake Claude = python loop, no key)
All core mechanics validated: ✅ tmux session lifecycle · ✅ 4 concurrent sessions · ✅ detached
survival (processes persist with no client) · ✅ attach/detach/**reconnect** (PTY survives disconnect)
· ✅ **resize** propagation (tmux client → 140x40) · ✅ **UTF-8** stdin echo + output round-trip
(`echo> héllo-世界-🚀 ✓`, needs a streaming decoder to avoid chunk-boundary splits) · ✅ **exit
detection** (process death *and* `quit` input remove the session) · ✅ **crash isolation** (kill one
pane pid → others alive) · ✅ concurrent multi-PTY streaming, **no head-of-line blocking**.

Operational measurements (2 vCPU / 4 GiB cgroup — the modest default tier):
- Sandbox limits confirmed at cgroup level: `memory.max` = 4 GiB, `cpu.max` = 2.0 CPUs.
- Idle baseline: ~35 MB memory, **~1% CPU**. Four **fake** sessions: +17.9 MB total, ~1.3% CPU
  (fake Claude is a sleeping python loop — light by construction).
- **Caveat:** fake-Claude footprints prove *runtime headroom + mechanics*, NOT real cost. Real Claude
  Code is a Node process (idle ~100–300 MB, CPU spikes during inference/tool use) — measure actual
  RAM/CPU per session in **Spike 4** before sizing the scheduler / per-computer session cap.
- tmux survives with no client attached ⇒ it will survive a `runtime-agent` restart (server is
  independent of the spawning process); PTY survives browser reconnect. Both confirmed.

### Canonical image manifest — `runtime-computer-v1` (snapshot id a31131cc…, active)
Base ubuntu:24.04, non-root user. Installed & version-verified: tmux 3.4, node 24.19, npm, go 1.22.2,
python 3.12.3, git + git-lfs 3.4.1, ripgrep 14.1, jq 1.7, docker CLI 29.1.3, unzip, curl, and
**Claude Code 2.1.221**. Zero bootstrapping needed before launching a workspace. Playwright browser
deps deferred (optional). `runtime_computers.image_version` records the image tag (`v1`, `v2`, …) each
computer was built from — reproducibility + upgrade path.

**Spike 3 — Claude JSONL watcher.** *(partially validated locally — see findings below)*
`Claude → ~/.claude/projects → watch → incremental parser → browser`. Verify: schema stability
across versions; flush timing; tool events; token accounting; multiple concurrent sessions.

**Spike 4 — Workspace layout.** Bare `repo.git` + `workspaces/{auth,ui,security}/` worktrees, each
with its own tmux + Claude; verify git worktree + tmux + Claude + replay coexist on one box.

**Spike 5 — Developer experience.** From `git clone` + `pnpm dev` to "New Workspace → Claude starts"
in one command. If not one command, improve onboarding before building features.

### Spike 3 — findings (real session, Claude Code 2.0.24)
- Records carry `uuid`/`parentUuid` (threading), `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`.
- Content blocks: `thinking`, `text`, `tool_use` (`id`/`name`/`input`/`caller`), `tool_result` (paired).
- `usage` on assistant: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `service_tier`.
- File also contains **app-internal record types** to ignore: `queue-operation`, `attachment`, `ai-title`, `last-prompt`, `mode`, `pr-link`, `system`.
- **Risk:** the format is internal, undocumented, and `version`-tagged — the parser must whitelist rendered types/fields and tolerate unknowns; pin/track the Claude Code version on the box.

## Phase 1+ build sequence (after Phase 0 passes)

- **Phase 1 — Foundations (no user-visible change):** shared `lib/runtime/git/` module + bare-mirror/worktree; `runtime_computers` migration + enums + `'daytona'` value + workspace columns; `agent-protocol.ts` (zod) + golden fixtures.
- **Phase 2 — Go runtime-agent core:** control API + PTY mgmt + WS streaming + JWT verify + Go tests (fake claude + real tmux). See [`runtime-agent.md`](./runtime-agent.md).
- **Phase 3 — Daytona provider + AgentClient (Next):** lazy provision box, install/boot agent, resume/destroy; TS `AgentClient`; Runtime-JWT minting endpoint.
- **Phase 4 — Browser:** xterm.js terminal via signed-preview-URL WSS; conversation view from JSONL stream; workspace list + create wired to lazy provisioning; diff panel reuse.
- **Phase 5 — Archive/resume:** PTY cast capture + upload to Supabase Storage; archive; resume (replay + `claude --continue`).
- **Phase 6 — Cleanup:** retire batch SSE path; six failure-mode tests; idle-time instrumentation.

## Open risks

- **WS-through-Daytona-proxy** (Spike 1) — if it fails, topology needs rethink (agent-owned TLS + direct port, or a relay).
- **Claude JSONL format drift** — internal/undocumented; defensive parser + version pinning (Spike 3).
- **Multi-writer PTY** — policy = one writer, others read-only.
- **Redaction on raw PTY** is weaker than on line-buffered logs; accepted for single-owner V1.
- **runtime-agent versioning** across a fleet of always-on boxes (deploy story; not V1-blocking).
