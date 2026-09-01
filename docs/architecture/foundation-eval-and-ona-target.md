# Foundation Evaluation & Ona-Class Target Architecture

**Status:** Draft for review
**Date:** 2026-08-31
**Context:** Which agent engine to build Runtime (Conductor + Conductor Cloud) on, and the target architecture that gets us Ona-class capabilities with low-prompt handoff.

---

## 1. TL;DR

- The product north-star is **Ona** (`app.gitpod.io` — Gitpod rebranded, now OpenAI-owned). Copy its surface: an intent launcher that picks a **model + agent + project + environment**, plus Automations/Insights/Fleets.
- **Ona's moat is the environment layer, not the agent.** The agent is swappable (they run GPT-5.6 behind an "Agent" dropdown). What's hard — and what Gitpod spent a decade on — is the cloud dev environment per session.
- **We own the compute substrate: RackBank / NeevCloud** (sovereign GPU+CPU cloud, India). This changes two layers:
  - **Model serving** — we can **self-host LLMs on NeevCloud GPUs** (vLLM/TGI → OpenAI-compatible endpoint) and plug them into jcode with `jcode provider add`, zero code. **This closes the original "custom provider addition must be viable" requirement** and gives cost control + data sovereignty + no vendor lock-in.
  - **Environment substrate** — cloud workers run on *our* cloud, not AWS. **Decided: Daytona self-hosted on NeevCloud** for per-session env orchestration (clone/deps/isolation/pause-resume). NeevCloud is the IaaS *under* Daytona. Our own sandbox is kept as a future replacement for Daytona's orchestration, not the v1 path.
- Target stack for Runtime:
  - **Agent brain → jcode** (swappable, but a strong fit for the *handoff* property specifically).
  - **Model serving → self-hosted on NeevCloud GPU** (OpenAI-compatible) via jcode's custom-provider path; API providers as fallback.
  - **Environment layer → Daytona self-hosted on NeevCloud** = our Gitpod = the moat, running on our sovereign cloud. (Own sandbox: future option.)
  - **UI → build on jcode's harness-API / TypeScript SDK**, styled as the Ona intent-launcher.
  - **Local vs Cloud → where `jcode serve` runs**: laptop (no env layer) vs inside a Daytona environment (full env layer). Same UI, same protocol.
  - **Handoff (the definition) → delegation, not migration.** A **local session is a control plane** that dispatches work to **cloud worker sessions** (each `jcode serve` inside a Daytona env). The workers run autonomously and report results back (PR/diff/summary) — the user never re-prompts each one. Same shape as Conductor's parallel worktree agents, except the workers are cloud Daytona sessions.
- **One thing to verify with code before committing:** can a **local jcode session spawn, drive, and collect results from remote cloud `jcode serve` instances** (via harness-API/SDK), passing enough context (plan + memory) that the worker needs no re-prompting? And does jcode's swarm coordination span hosts, or only within one server? This is the joint between our two locked pieces.

---

## 2. The layer model (how to think about all of these products)

Every product in this space is some subset of five layers. The moat is almost never the top layer.

| Layer | What it is |
|---|---|
| **A. Agent brain** | The plan → build → test → fix loop; tool calling; providers; multi-agent (planner/reviewer). |
| **B. Orchestration** | Many sessions in parallel, worktrees, fleets, a UI, diff review, task → PR. |
| **C. Environment** | A real place the agent runs: repo cloned, deps installed, DB/services up, sized compute, network/VPC, secrets. |
| **D. Verification** | Real build/test/browser runs; proof (video, CI, screenshots) attached to the PR. |
| **E. Product surface** | Integrations (GitHub/Linear/Slack/Sentry), triggers (PR/schedule/webhook), governance (VPC, policy, SOC2), and the **async / no-laptop** property. |

**Key point:** A + B are commoditizing fast. **C + D + the async part of E are the moat**, and they are structurally *cloud* concerns.

---

## 3. Candidate foundations, mapped

| Candidate | Owns agent loop? | Provider model | Layer it lives at | License | Fit for us |
|---|---|---|---|---|---|
| **opencode** (`anomalyco/opencode`) | Yes | Vercel AI SDK + models.dev; config-driven custom providers | A (brain) | MIT | Strong TS brain; richest provider abstraction |
| **jcode** (`1jehuang/jcode`) | Yes | `jcode-provider-*` crates + OpenAI-compatible + `jcode provider add` | A (brain) + strong handoff primitives | MIT | **Chosen brain** — see §4 |
| **superset** (`superset-sh/superset`) | No — runs other CLIs | N/A (delegates) | B (orchestrator) | ELv2 | Wrong layer; restrictive license |
| **herdr** (`herdr.dev`) | No — runs other CLIs | N/A (delegates) | B (orchestrator, persistent) | Apache 2.0 | Wrong layer; peer of what we're building |
| **Vorflux** | Yes (proprietary) | proprietary | A+B+C+D (full cloud autopilot) | closed | Reference for the *moat*, not a foundation |
| **Ona / Gitpod** | Agent swappable | proprietary | **A+B+C+D+E** (full stack) | closed / SaaS | **Product north-star** |

Orchestrators (superset, herdr) are the wrong layer: they wrap *other* agents and own no provider/brain of their own. Adding a custom provider there means configuring the sub-agent, not the platform.

---

## 4. Why jcode is the right brain — specifically for handoff

The product thesis is **"handoff works without much prompting."** That is not a UI feature; it's a property of the engine's state model. jcode ships the primitives as first-class crates:

| Handoff need | jcode primitive |
|---|---|
| Agents coordinate without a human relaying | `jcode-swarm-core` — agents DM/broadcast; when agent A edits a file agent B read, the **server notifies B automatically** to resolve it. Prompt-free coordination. |
| Context survives across stages | `jcode-embedding` + `jcode-memory-types` (semantic memory) + `jcode-plan` (plan travels with the task) + `jcode-compaction-core` (keeps carried context small) |
| Session survives disconnect / moves hosts | `jcode serve` + `jcode connect` + `jcode-protocol` + `jcode-transport` — reconnect to a live session from any device |
| Long-running autonomous work | `jcode-overnight-core`, `jcode-background-types` |
| Provider flexibility | `jcode-provider-core` + per-provider crates + `jcode provider add` (config-driven, incl. arbitrary OpenAI-compatible endpoints) |

Architecturally decisive: jcode is **already split into engine + protocol + clients.** The ~20 `jcode-tui-*` crates are *one frontend* over `jcode-harness-api`. A new UI is a **sibling of the TUI**, not a fork of the agent. There is also `sdk/typescript`, `sdk/npm`, and an existing **`ios/` Swift client** — living proof a GUI can be built on the seam.

License: **MIT.** Risk: single-maintainer, fast-moving (7k+ commits). Mitigation: **pin a commit**, treat SDK upgrades as deliberate events.

**Note:** opencode remains a viable alternative brain if we later prefer an all-TS engine with the richest provider catalog. The decision below is reversible because the brain sits behind the protocol seam.

---

## 5. What Ona actually is (and what it teaches us)

Ona is Gitpod + agents. The signup screenshot is a spec:

- **Intent box** — "What do you want to get done today?" (a task launcher, not a chat).
- **Model picker** (GPT-5.6) + **Agent-mode** dropdown → engine is swappable.
- **Project picker** → which repo/config.
- **Environment/compute picker** — "Regular · 4 vCPU / 16 GiB / 80 GiB disk" ← **the tell.** Every other agent UI picks a *model*; Ona also picks a *machine*. That is the Gitpod environment layer surfaced in the launcher.
- Left nav: **Projects, Automations, Insights, Sessions.**

Lesson: the agent is the cheap, swappable part. **The environment layer is the moat.** Vorflux confirms this from the other side (EC2-per-session). Ona confirms it by being a dev-environment company that simply added agents.

---

## 6. Target architecture

The local session is the **control plane / orchestrator**; cloud worker sessions are the **fleet**. The user drives one local session and delegates work out to N cloud workers.

```
                 Runtime UI  (intent box + model + project + ENV picker)
                             build on jcode harness-API / TS SDK
                                          │
                        ┌─────────────────┘
                        ▼
        LOCAL SESSION  (control plane)
        jcode serve on the laptop
        - interactive, in the user's real repo
        - defines task + context bundle (plan + memory)
        - dispatches work, monitors, collects results
                        │
        dispatch (task + context)  ▼          ▲  results (PR / diff / status)
        ┌───────────────┬──────────────────────┬───────────────┐
        ▼               ▼                       ▼               ▼
   CLOUD WORKER 1   CLOUD WORKER 2   ...   CLOUD WORKER N     (a "fleet")
   jcode serve      jcode serve            jcode serve
   inside Daytona   inside Daytona         inside Daytona
   repo cloned,     repo cloned,           repo cloned,
   deps, sized VM,  deps, sized VM,        deps, sized VM,
   VPC              VPC                     VPC
   (runs autonomously; laptop can disconnect and reconnect later)
```

Because each worker persists via `jcode serve`, the laptop can **disconnect and reconnect** — that gives us the Ona "async / no-laptop" property even though the *initiator* is a local session.

### Mapping Ona's surface to who provides it

| Ona surface | Provider in our stack |
|---|---|
| Intent UI, model + agent + project pickers | **We build** (on jcode TS SDK) |
| Model picker (GPT-5.6 etc.) | **Self-hosted on NeevCloud GPU** (OpenAI-compatible) via jcode custom provider; API providers fallback |
| Environment/compute picker | **Daytona self-hosted on NeevCloud/RackBank** compute (own sandbox = future option) |
| Agent brain (plan/build/test/fix, task→PR) | **jcode** |
| Automations (PR/schedule/webhook triggers), Fleets | **We build** (orchestration layer over jcode sessions) |
| Insights | **We build** (session/usage telemetry) |
| Governance (in-VPC, policy, audit, sovereignty) | **NeevCloud (India-sovereign) + we build** |
| Low-touch handoff ("PR returned already reviewed") | **jcode primitives + review policy we build** |

### Substrate advantage (owning RackBank / NeevCloud)

Unlike Ona (on AWS) or Vorflux (EC2), we own the compute. That's a real moat, not just cost:

- **Own the inference.** Self-hosted models on NeevCloud GPUs served as OpenAI-compatible endpoints → jcode's `jcode provider add` consumes them with no code. We control model choice, cost-per-token, and can fine-tune on NeevCloud. This is the answer to the message-1 "custom provider" question.
- **Data sovereignty.** Code + prompts never leave Indian data centers — a concrete enterprise selling point Ona/Vorflux can't match for that market.
- **No vendor lock-in / unit economics.** Pay-per-second GPU we already operate, vs. paying AWS margins + API-provider margins.
- **Caveat — orchestration ≠ compute.** NeevCloud gives us VMs/GPU. Turning those into per-session dev environments (repo clone, deps, snapshot, pause/resume, isolation) is still an orchestration layer — either our own sandbox or self-hosted Daytona. Decide this before the cloud tier (unknowns §8).

### Local vs Cloud is one product

- **Local Conductor** = `jcode serve` on the laptop, task runs in a local worktree. No environment layer. Fastest path; jcode covers most of it.
- **Conductor Cloud (Ona-class)** = the *same* `jcode serve`, running *inside a Daytona environment*. The environment picker in the UI selects a Daytona sandbox spec.
- The UI connects to either host over the same jcode protocol. The only real difference is *where the process runs and who provisions its filesystem/network*.

---

## 7. The handoff design (the differentiator)

**Handoff = a local session gets work done by cloud sessions, without re-prompting each one.** It is *delegation*, not migration. The local session stays the coordinator; cloud workers execute.

The flow has four primitives, in order:

1. **Context bundle.** The local session packages what a worker needs to run cold: `jcode-plan` (the plan) + relevant `jcode-embedding`/`jcode-memory-types` (memory) + repo ref + task spec. This bundle is *why the worker needs no re-prompting* — the intent travels with the task.
2. **Remote spawn.** The local session provisions a Daytona env and starts a `jcode serve` worker inside it, then hands it the bundle over the harness-API/protocol. (Requires: a local session can act as a client/driver of a *remote* jcode server.)
3. **Autonomous execution + status.** The worker runs the task to a result (PR/diff/summary), reporting status (working / blocked / done). Laptop may disconnect; `jcode serve` persistence + `jcode-background-types`/`jcode-overnight-core` keep it going.
4. **Result aggregation.** Worker output surfaces back in the local session's UI — diffs to review, PRs to merge, summaries. The local session is where the human stays in the loop.

**Fan-out (the fleet):** steps 1–4 run for N workers in parallel — the Conductor model, cloud-hosted. This is also where planner/reviewer separation lives: a reviewer worker can be dispatched to check a builder worker's PR.

The load-bearing question this raises: **does jcode's coordination (`jcode-swarm-core`) span hosts (local orchestrator ↔ cloud workers), or is it single-server only?** If single-server, the cross-host dispatch/aggregation is a **Runtime control-plane layer we build** on top of jcode's harness-API — not something jcode gives us for free. See unknowns §8.

### Transport reality (verified against code, 2026-08-31)

The `@1jehuang/jcode-sdk` (TS, protocol v1, MIT, on npm) talks **NDJSON over a local Unix socket** (`$XDG_RUNTIME_DIR/jcode-api.sock`; named pipe on Windows) — **not TCP.** It connects to a bridge on the *same machine*. Consequences for UI wiring:

```
Mac app / web UI ──HTTP/WS──► Runtime control-plane shim ──local Unix socket──► jcode
  (your client)   (network,      (runs INSIDE the sandbox,       (@jcode-sdk)   (in sandbox)
                   your API)       uses @1jehuang/jcode-sdk)
```

- **Cloud/Daytona tier:** a thin **control-plane shim runs co-located with jcode inside each sandbox**, drives it via the SDK's `launch()` (private instance, own state — ideal per-worker isolation; `inheritLogins:false` + NeevCloud creds), and exposes *our own* network API (HTTP/WS) to the UI and to the local orchestrator. This shim **is** the worker's remote surface and the piece that makes delegation work. Small to build.
- **Local tier:** the Mac app drives a local jcode directly over the SDK (`launch` for a private instance, or `connect` to the user's own running jcode via `jcode api-bridge`). No shim needed locally.
- **Design win:** the UI couples to *our* stable API, not jcode's protocol.
- **Provider path confirmed:** `jcode provider add <name> --base-url <neevcloud>/v1 --api-key-stdin` → self-hosted NeevCloud model as a named profile, zero code. `launch()` supports `inheritLogins:false` to run with only our creds.

---

## 8. Open technical unknowns (de-risk in this order)

1. **[BLOCKER → mostly resolved] Remote drive.** ~~Can a local session drive a remote `jcode serve` over the protocol?~~ **Verified: the SDK is local-socket only (NDJSON over Unix socket), not networked.** The remote-drive seam is therefore a **control-plane shim co-located with jcode inside each sandbox** (uses the SDK's `launch()` locally, exposes HTTP/WS to us). Remaining check: build that shim and confirm the round-trip (dispatch context bundle → run → collect result) end to end.
2. **[BLOCKER] Cross-host coordination.** Does `jcode-swarm-core` coordination span hosts (local ↔ cloud workers), or is it single-server only? Given #1, cross-host is almost certainly **our control plane's job**, not jcode's — swarm likely coordinates only agents within one server. Confirm, then own the dispatch/aggregation layer.
3. **jcode-inside-Daytona seam.** Does `jcode serve` (headless daemon + `jcode api-bridge`) run cleanly inside a Daytona sandbox (repo cloned, deps, no TTY)? The SDK can bootstrap the runtime via its optional platform package. Confirm on a real Daytona box.
4. **Context bundle fidelity.** Can a worker be started from an exported plan + memory + repo ref and run *without re-prompting*, producing the same quality as an interactively-prompted session? This is the actual product promise; validate it early with a real task.
5. **[resolved] TS SDK surface.** `@1jehuang/jcode-sdk` v1.2.0 (protocol v1) covers sessions (`createSession`), turns (`run`), streaming (`onEvent`/`text_delta`), tool calls, usage, structured output, auto-approve, and two modes (`launch` private instance / `connect` to user's jcode). Transport is local Unix socket — see §7. Surface is sufficient; the network layer is ours to add via the shim.
6. **Result flow-back.** How does a worker's PR/diff/status surface back into the local session's UI for human review? Poll, subscribe, or webhook.
7. **Daytona-on-NeevCloud viability.** *(Decision made: Daytona for now.)* Confirm Daytona self-hosts cleanly on NeevCloud compute — GPU/CPU sandbox specs, snapshot/pause-resume, and network access work on their IaaS. Own sandbox is deferred.
8. **Self-hosted model readiness.** *Provider plumbing confirmed* (`jcode provider add --base-url <neevcloud>/v1`). Open is model-side quality: can our vLLM/TGI endpoint deliver reliable **tool-calling + streaming (+ vision)** for the models we pick? Validate tool-calling especially — many self-hosted stacks are weak there, and the agent is useless without it.
9. **Protocol stability under a pinned commit.** Single maintainer; confirm we can pin and upgrade deliberately.
10. **Verification layer (Ona Layer D).** Real-browser test + proof-on-PR is net-new. Sequence *after* local + cloud dispatch land.

---

## 9. Recommended sequencing

1. **Spike the shim + Daytona seam** (unknowns #1–3) — build the thin control-plane shim (wraps `@jcode-sdk` `launch()`, exposes HTTP/WS), run it + jcode inside a Daytona sandbox on NeevCloud, and drive it from outside: dispatch a context bundle → run → collect the diff. This is the delegation model in miniature. A spike, not a commitment.
2. **Local Conductor on jcode** — intent UI + model/project pickers + session/diff review over the TS SDK. Fastest value; jcode covers most of it.
3. **Context bundle + dispatch** — package plan+memory+repo, start one cloud worker, collect its result. The minimum viable handoff.
4. **Fleet fan-out** — N cloud workers dispatched from one local session, results aggregated for review. The Conductor-cloud model.
5. **Automations / Insights** — triggers (PR/schedule/webhook) and telemetry over sessions.
6. **Verification + governance** (Ona Layer D/E) — the last, hardest moat pieces.

---

## 10. Open questions for review

1. Is jcode locked as the brain, or do we want a spike comparing it against opencode (all-TS, richest provider catalog) before committing? The protocol seam makes this reversible, but the handoff-primitive advantage leans jcode.
2. ~~What does "handoff" mean?~~ **Resolved:** a local session dispatches work to cloud worker sessions that run autonomously and report back (delegation, not migration). See §7.
3. Does a worker return a **finished PR** (Ona "task in, PR out"), or a **reviewable diff in the local session** the human merges? Changes the flow-back design (§8 #6) and how much review policy we build.
4. **Fleet granularity:** is a "task" split across many workers (frontend/backend/infra for one feature, Vorflux-style), or is each worker one independent task? Changes the dispatch + aggregation model.
5. ~~Environment orchestration: own sandbox or Daytona?~~ **Resolved:** Daytona self-hosted on NeevCloud for now; own sandbox deferred as a future replacement.
6. **Models:** self-host on NeevCloud GPU (own inference, sovereignty, cost), API providers (Claude/GPT — quality, tool-calling), or both with routing? My lean: **both** — self-host for volume/cost/sovereignty, API providers for the hardest reasoning, jcode's provider layer routes between them.
7. For Conductor Cloud, do we need the full Ona governance story (in-VPC, sovereignty attestation) in v1, or is that a later enterprise tier?
8. Is the local tier a true first-class product, or a dev/preview mode on the way to cloud?
