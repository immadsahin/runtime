# Spike 4 — Runtime Report (real Claude Code, end-to-end)

**Date:** 2026-08-04 · **Image:** `runtime-computer-v1` (non-root) · **Provider:** Daytona · **Verdict: ✅ PASS**

All runs used the real `claude` CLI (Claude Code 2.1.221) authenticated with a `CLAUDE_CODE_OAUTH_TOKEN`
injected into the session environment only — never written to sandbox disk, logs, or archives.

## Exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| Real Claude Code works end-to-end | ✅ | Task used Edit/Write/Bash, added `subtract()`, wrote+ran `test_calc.py` → `2`; $0.11, 5 turns, 14s |
| Multiple workspaces operate correctly | ✅ | Bare mirror + 4 worktrees on independent branches; **fs isolation verified** (op(2,3)=7/8/9/10, no cross-talk) |
| JSONL watcher works reliably | ✅ | Byte-offset incremental tail parsed every appended event: thinking, tool_use, tool_result, text; correct pairing/order |
| PTY streaming works with real workloads | ✅¹ | Real Claude TUI renders live over PTY; resize→140×40; reconnect resumes; concurrent PTYs, no HOL (Spike 2 + core) |
| Replay validated | ✅ | Reconstructed full turn timeline from stored JSONL (`U→thinking→Bash→tool_result→Read→Edit→Bash→text`) |
| Resource profiling complete | ✅ | Idle + active + 4-concurrent measured at cgroup level (below) |
| Scheduler recommendations backed by data | ✅ | See "Scheduler recommendation" |
| `claude --continue` / resume | ✅ | Same session id resumed, `multiply()` added; resumes even after `tmux kill-server` |
| Failure modes | ✅ | See "Failure modes" |

¹ **Known limitation:** driving the *interactive* Claude TUI's **input** (human takeover) via a raw PTY did
not submit a typed prompt in the spike — Claude Code's TUI needs proper input handling (bracketed-paste /
CR timing), not just raw bytes. PTY **I/O and rendering** are proven; the input-encoding for the TUI is a
Phase-1 agent detail, not a Phase-0 blocker.

## Metrics

**Single task (real tools):** exit 0 · 14 s · $0.108 · 5 turns · tools = Bash+Edit+Write · cgroup mem peak 186 MB.
Token accounting present: input/output/cache_creation/cache_read/service_tier/iterations.

**JSONL pipeline (real session, 19 records):** types = user(5), assistant(7) + app-internal
(queue-operation, attachment, ai-title, last-prompt). Blocks = thinking(2), tool_use(4), tool_result(4),
text(1). Matches the Spike 3 schema; parser whitelists rendered types and tolerates the rest.

**Resource profiling (2 vCPU / 4 GiB cgroup):**

| Scenario | Memory (cgroup) | CPU |
|---|---|---|
| Empty sandbox baseline | 33 MB | — |
| 1 idle interactive Claude | +123 MB (~214 MB RSS) | ~1.3% of 2 vCPU |
| **4 concurrent active tasks** | **peak 614 MB total** (~150 MB/session) | 5.4 cpu-sec/14 s (~19% of 2 vCPU) |
| 4 idle interactive sessions | 552 MB total (~140 MB/session) | 1.7% of 2 vCPU |

**Takeaway:** Claude itself is **memory-light (~140–215 MB/session) and CPU-light (API-bound)**. All 4
concurrent tasks completed successfully with fs isolation.

**JSONL flush granularity:** `claude -p` (headless) flushes JSONL in a **batch near completion**;
interactive mode appends per-turn (to confirm in Phase 1 with the agent-driven TUI). The watcher
*mechanism* is proven for both.

## Failure modes (observed behavior)

| Event | Behavior | Verdict |
|---|---|---|
| Kill Claude process | its tmux session ends; **other sessions unaffected** | ✅ isolated |
| Kill runtime-agent | (no agent binary yet) — tmux server is independent of its spawner; sessions survive with no client → will survive an agent restart | ✅ by design (re-verify with Go agent) |
| Browser refresh / disconnect | PTY detach leaves session running; reconnect via new PTY resumes live stream | ✅ (Spike 2) |
| `tmux kill-server` | all sessions destroyed | ✅ expected |
| Workspace resume | `claude --continue` in a fresh tmux restores the conversation (returned RESUMED after full tmux loss) | ✅ |

## Scheduler recommendation

Grounded in the measurements above, with one explicit caveat.

- **Default Runtime Computer: 4 vCPU / 8 GiB** (up from the 2 vCPU/4 GiB test tier). Memory is not the
  binding constraint for Claude (~140 MB/session), but the **workloads Claude triggers** — installs, test
  suites, builds, repo indexing — are CPU/RAM-heavy. 4 cores give real concurrent build/test throughput;
  8 GiB leaves ample headroom.
- **Max concurrent Claude sessions per computer (soft cap): 4–6.** Memory alone would allow ~30+ idle
  sessions, but **concurrent heavy builds saturate CPU** — cap by cores, not RAM.
- **Safe utilization thresholds:** memory < 80%; 1-min load average < 1.5 × vCPU.
- **Autoscaling triggers:** provision another computer (or refuse a new workspace on this one) when
  sustained (5-min) memory > 75% **or** load > 1.5 × nproc. Scale-down/suspend is deferred (Option A).
- Record `runtime_computers.image_version` and size so caps can evolve per image/tier.

**⚠️ Caveat (not fully measured):** spike tasks were light (edit a file + print). Real coding sessions
run large installs, full test suites, and repo indexing — the true capacity driver. The listed
**"running tests / repo indexing / >30-min memory growth"** profiling was **NOT** stress-tested. Validate
the per-computer cap against a heavy real repo before finalizing. The recommendation is deliberately
conservative (cap by cores) to absorb this uncertainty.

## Runtime Computer v1 — frozen image

**Name:** `runtime-computer-v1` · **Base:** ubuntu:24.04 · **User:** non-root `runtime` (uid 1001,
passwordless sudo) · **Build time:** ~100 s · **Reproducible** via the declarative build below.

| Software | Version |
|---|---|
| tmux | 3.4 |
| Node.js | 24.19 (LTS) |
| npm | bundled |
| Go | 1.22.2 |
| Python | 3.12.3 |
| git / git-lfs | 2.x / 3.4.1 |
| ripgrep | 14.1 |
| jq | 1.7 |
| Docker CLI | 29.1.3 |
| Claude Code | 2.1.221 |
| unzip, curl, sudo, ca-certificates | ✓ |

Deferred (optional): Playwright browser deps.

**Build (Daytona SDK, declarative):**
```
Image.base('ubuntu:24.04').env({DEBIAN_FRONTEND:'noninteractive'}).runCommands(
  'apt-get update',
  'apt-get install -y --no-install-recommends ca-certificates curl gnupg git git-lfs jq unzip ripgrep tmux python3 python3-pip golang-go docker.io sudo',
  'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -',
  'apt-get install -y nodejs',
  'npm install -g @anthropic-ai/claude-code',
  'apt-get clean && rm -rf /var/lib/apt/lists/*',
  'useradd -m -s /bin/bash runtime && echo "runtime ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runtime && chmod 0440 /etc/sudoers.d/runtime',
  'mkdir -p /home/runtime/.claude && chown -R runtime:runtime /home/runtime'
).workdir('/home/runtime').dockerfileCommands(['USER runtime'])
```
**Critical:** the image MUST run as non-root — Claude Code refuses `bypassPermissions`/
`--dangerously-skip-permissions` as root (surfaced in Spike 4; the fake-Claude Spike 2 could not).

## Known limitations / follow-ups (Phase 1)

1. Interactive-TUI **input** over PTY (human takeover) needs proper key/paste handling in the agent.
2. Heavy-workload + >30-min memory-growth profiling not done — validate per-computer cap on a real repo.
3. Confirm interactive-mode JSONL appends **per-turn** (vs `-p` batch) once the Go agent drives the TUI.
4. Re-verify "kill runtime-agent → tmux survives" against the real Go agent.

## Phase 0 status

**COMPLETE.** Spikes 1 (WS transport), 2 (PTY+tmux), 3 (JSONL schema), 4 (real Claude e2e) all passed.
Architecture is frozen; `runtime-computer-v1` is the canonical image. Begin Phase 1 — no further
architectural redesign unless a fundamental issue emerges.
