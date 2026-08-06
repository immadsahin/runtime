# Runtime

Runtime runs the real Claude Code CLI in a persistent cloud workspace you drive
from the browser. You get a live terminal and a structured conversation you can
close your laptop on and reconnect to — the agent keeps running. Conductor-style
workflow, but the session lives in the cloud, not on your machine.

## How it works

- One **Runtime Computer** — a long-lived [Daytona](https://daytona.io) box per
  project, built from a frozen versioned image.
- One **Workspace** = one Claude Code session, in a tmux + git worktree on that
  box.
- A Go **runtime-agent** on the box exposes the live PTY over WebSocket and
  streams the conversation; a Next.js + Supabase control plane handles auth,
  GitHub, and lifecycle.

## Status

Phase 0–2 are complete. M3 Workspace Session and M4 Archive / Replay / Restore
are implemented and locally verified; their authenticated real-Daytona
acceptance runs and Runtime-only dogfood gate remain. See the canonical
[`docs/architecture/PROGRESS.md`](docs/architecture/PROGRESS.md).

## Local setup

1. Copy `.env.example` → `.env.local`; fill the Supabase and GitHub owner values.
2. Apply `supabase/migrations/*.sql` in filename order (Supabase SQL editor or CLI).
3. `pnpm install && pnpm dev`

`GITHUB_PAT` is server-only, must belong to the configured Runtime owner, and
needs repo **Metadata: Read**, **Contents: Read/write**, and **Pull requests:
Read/write**. Keep it out of `NEXT_PUBLIC_*` and commits.

## Docs

- Architecture — [`docs/architecture/runtime-v1-plan.md`](docs/architecture/runtime-v1-plan.md)
- Agent & protocol — [`runtime-agent.md`](docs/architecture/runtime-agent.md), [`protocol.md`](docs/architecture/protocol.md)
- Validation report — [`spike4-runtime-report.md`](docs/architecture/spike4-runtime-report.md)
- E2B provider research and verification gate — [`e2b-provider-spike.md`](docs/architecture/e2b-provider-spike.md)
