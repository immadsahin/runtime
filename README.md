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
- The browser opens the terminal WebSocket **directly to the box** via a Daytona
  signed preview URL, so the control plane never proxies long-lived connections.

## Status

Phase 0 (architecture validated end-to-end on Daytona) through Milestone 2
(interactive execution path) are complete. Milestone 3 (workspace session
experience) and Milestone 4 (archive / replay / restore) are implemented, with
real-Daytona acceptance runs pending. See
[`docs/architecture/PROGRESS.md`](docs/architecture/PROGRESS.md).

## Local setup

1. Copy `.env.example` → `.env.local`; fill the Supabase and GitHub owner values.
2. Apply `supabase/migrations/*.sql` in filename order (Supabase SQL editor or CLI).
3. `pnpm install && pnpm dev`

`RUNTIME_PROVIDER=local` (the default) runs workspaces in a directory on your
machine — no cloud spend. Set `RUNTIME_PROVIDER=daytona` for the real Runtime
Computer backend.

`GITHUB_PAT` is server-only, must belong to the configured Runtime owner, and
needs repo **Metadata: Read**, **Contents: Read/write**, and **Pull requests:
Read/write**. Keep it out of `NEXT_PUBLIC_*` and commits.

## Deploy

The control plane is a standard long-running Next.js server; Supabase and Daytona
are managed services, so hosting the app is the only thing you deploy. Full
runbook (env vars, auth wiring, checklist): **[`docs/deploy-railway.md`](docs/deploy-railway.md)**.

On each provision the Daytona provider uploads the cross-compiled `runtime-agent`
binary to the box, so it must ship with the deploy. Build and commit it whenever
`runtime-agent/**` changes:

```bash
bash scripts/build-agent.sh "$(pwd)/bin/runtime-agent-linux-amd64"
git add bin/runtime-agent-linux-amd64
```

Then point `RUNTIME_AGENT_BINARY_PATH=bin/runtime-agent-linux-amd64` and set
`RUNTIME_PROVIDER=daytona` in the deploy environment.

## Docs

- Architecture — [`docs/architecture/runtime-v1-plan.md`](docs/architecture/runtime-v1-plan.md)
- Agent & protocol — [`runtime-agent.md`](docs/architecture/runtime-agent.md), [`protocol.md`](docs/architecture/protocol.md)
- Validation report — [`spike4-runtime-report.md`](docs/architecture/spike4-runtime-report.md)
- Deploy — [`deploy-railway.md`](docs/deploy-railway.md)
</content>
