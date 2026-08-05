# Mission Engine v0 — Design

> **This document is intentionally blocked on Runtime M3. It is a design document only.
> Implementation begins only after Runtime reaches its M3 success criteria and exposes
> stable Workspace APIs plus Workspace completion events.**

## Status

- **Design:** ✅ Frozen
- **Implementation:** 🚫 Blocked
- **Blocked on:**
  - Runtime **M3** complete (the single-workspace loop working end-to-end)
  - Stable **Workspace APIs** (create / prompt / stream / complete / archive / resume)
  - **Workspace completion events**

This document is intentionally not actionable until the above conditions are met.

---

## One sentence

> A deterministic engineering workflow engine where **Runtime enforces the lifecycle**
> and an **LLM provides judgment only where human reasoning is required**.

It is **not** autonomous software engineering. The objective is: *start a Mission before
sleeping, and wake up to engineering work that is ready to review* (or to a paused Mission
with a clear decision waiting). Automatic merge is out of scope — the deliverable is
PRs ready for a human to merge.

---

## Non-negotiable principles

1. **Mission is the first application built on Runtime.** It consumes Runtime exactly like
   any future client would. If Mission needs a change to Runtime's core abstractions,
   **fix Runtime first** — do not smuggle Mission concerns into Runtime core.
2. **Runtime owns the lifecycle; the LLM owns judgment.** Code owns *when* to act and
   *whether* to proceed; the model owns *content* and *verdicts* only.
3. **The engine is correct even if the model is dumb.** The state machine, templates,
   budgets, persistence, and event handling are all unit-testable with the LLM stubbed.
   The model is called at exactly three sites (below).
4. **Restart-safe.** Every decision and transition is persisted. If the engine crashes
   mid-Mission, it resumes from the last completed phase — no repeated work, no duplicate
   workspaces, no lost state. (Mirrors Runtime's own reconciliation philosophy.)
5. **Never loop forever.** Hard budget rails. On breach → *pause → report why → wait for
   human*. A paused Mission is the system working correctly, not a failure.
6. **Mission does not know Claude exists.** It knows Workspace, Status, Summary, Diff, and
   Events. A Workspace could later run Codex, Gemini CLI, or a future agent and Mission
   would not change.

---

## Layering

```
┌──────────────────────────────────────────────┐
│                 Mission Engine               │
│  Mission State Machine · Templates           │
│  Budget Rails · LLM Decisions                │
└──────────────────────────────────────────────┘
                     │  (a client of Runtime, nothing more)
                     ▼
┌──────────────────────────────────────────────┐
│                  Runtime API                 │
│  Create Workspace · Send Prompt · Stream     │
│  Complete · Archive · Resume · Events        │
└──────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│              Runtime Computer                │
│  runtime-agent · Claude Code · Worktree · PTY│
└──────────────────────────────────────────────┘
```

The Mission Engine owns the **mission** lifecycle. Runtime owns the **workspace**
lifecycle. The Engine is a client — it never opens a terminal, clones git, or edits code.

---

## The three LLM call-sites

Everything else is deterministic. The model is called only to:

1. **Generate a phase prompt** — from the template's prompt-template + mission context.
2. **Judge a phase's output** — `accept` or `reject + feedback` (bounded by `max_iterations`).
   This is a real judgment, **not** a file-exists check: "`architecture.md` exists" ≠
   "the architecture is good."
3. **Write the mission report.**

| Owned by Runtime / the engine (code) | Owned by the LLM (judgment) |
| --- | --- |
| lifecycle & transitions | generate phase prompt |
| retries & retry bounds | judge phase output (accept / reject+feedback) |
| budgets & pause/resume | write mission report |
| templates & persistence | |
| events & scheduling | |

---

## Mission lifecycle (code-owned state machine)

```
enum MissionState {
  DISCOVERY,
  ARCHITECTURE,
  ARCHITECTURE_COMPLETE,
  IMPLEMENTATION,
  IMPLEMENTATION_COMPLETE,
  VERIFICATION,
  COMPLETE,
  PAUSED,   // budget breach or unresolved rejection → wait for human
  FAILED,
}
```

Transitions are code. Each `*_COMPLETE` gate is the LLM **acceptance** verdict (call-site
2): on `reject`, the engine re-runs the phase with feedback until it accepts or
`max_iterations` is hit (→ `PAUSED`). The **VERIFICATION → COMPLETE** gate is
**adversarial**: an independent Workspace reproduces and measures, emitting
`PASS` / `FAIL` / `PARTIAL` with evidence — the implementer never grades its own homework.
This gate is the single highest-risk component of the system.

The v0 spine is three Workspaces:

```
Mission → Architecture → Implementation → Verification → Report
```

No review Workspaces, no testing Workspace, no DAG (see *Out of scope*).

---

## Templates are first-class data

A template is declarative configuration, not code. Adding a workflow is config.

```yaml
name: Feature
phases:
  - architecture
  - implementation
  - verification
limits:
  max_iterations: 2
  max_workspaces: 3
  max_duration: 8h
  max_tokens: <configurable>
  max_cost: <configurable>
```

Each phase references a **prompt template**, an **acceptance rule**, and a **retry policy**.

Starter templates:

- **Feature** — architecture → implementation → verification
- **Bug Fix** — implementation → verification
- **Refactor** — architecture → implementation → verification

---

## Budget rails

Every Mission carries hard limits: `max_duration`, `max_workspaces`, `max_iterations`,
`max_tokens`, `max_cost`. On *any* breach:

```
Mission → PAUSED → report the reason → wait for human
```

The report must make the pause reason and a **safe one-click resume** obvious — otherwise
a correctly-paused Mission reads as a failure. This is a **safety rail**, not cost
optimization (which stays out of scope).

---

## Model choice

**One vendor for v0.1** — one auth flow, one billing, one SDK. Introduce a second
coordinator model only on concrete, measured advantage.

---

## The Runtime contract Mission depends on (the unblock condition)

Mission needs Runtime to expose, on a single Workspace:

- `createWorkspace` · `sendPrompt` · `streamConversation` · `getStatus`
- `getSummary` · `getDiff` · `archiveWorkspace` · `resumeWorkspace`
- **workspace completion events**

That set is **identical to Runtime's own M3 success criteria + a completion event.**
Finishing Runtime *is* the prerequisite — Mission does not compete with Runtime for
attention; it is gated on Runtime reaching its own finish line.

---

## Out of scope for v0

Review Workspaces · DAG scheduling · recursive planning · recursive Missions · testing
Workspace · automatic merging · multi-project execution · browser automation · Slack ·
calendar · Coordinator memory · human-approval workflow · cost optimization · multiple
Coordinator models.

---

## Success criteria

A user creates a Mission, closes their laptop, and wakes up to either:

- a Mission **ready for review** (PRs ready to merge, with an engineering report), or
- a Mission **paused** with a clear, resumable decision,

…without additional prompting. v0.1 exists to prove Runtime can automate the exact
engineering process (debate → freeze → implement → verify) used to build Runtime itself.

---

## When to unfreeze

When Runtime hits its M3 success criteria and emits workspace completion events, apply the
same discipline used for Runtime: **debate → freeze → implement → verify**. At that point
this is a small layer on a proven primitive, not a competing foundation.
