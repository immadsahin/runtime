# Deploying Runtime to Railway

Runtime's control plane (this Next.js app) runs well on Railway. Supabase (auth +
Postgres + Storage) and Daytona (the Runtime Computers) are managed services, so
Railway is the only thing you deploy.

Railway is a good fit: it runs a **long-lived container** (`next start`), not
ephemeral serverless functions. That means no per-request duration cap to work
around, and provisioning (boot a Daytona box + agent, ~15s, plus a repo mirror)
just runs to completion inside the request.

The live terminal never touches Railway anyway: the browser opens a WebSocket
**directly to the Daytona signed preview URL** (`docs/architecture/runtime-v1-plan.md`,
decision 1A).

## Build & run

Railway (Nixpacks) auto-detects the Next.js app. The scripts already do the right
things:

- Build: `next build`
- Start: `next start --port ${PORT:-3000}` — already binds Railway's injected `$PORT`.

Set the package manager if Nixpacks guesses wrong (this repo uses **pnpm** — a
`pnpm-lock.yaml` is present). No Dockerfile is needed. Add a **health check** on
`/api/health` in the Railway service settings.

## The agent binary (the one thing you must not miss)

On each provision the Daytona provider reads the cross-compiled `runtime-agent`
binary and uploads it to the box (`lib/runtime/daytona-provider.ts` →
`lib/runtime/daytona/deploy.ts`). The default output path (`.context/build/…`) is
gitignored, so a tracked copy is committed at **`bin/runtime-agent-linux-amd64`**
and pointed at via `RUNTIME_AGENT_BINARY_PATH`. Under `next start` the whole repo
is on disk, so the file is read directly — no bundling tricks needed (unlike a
Vercel/standalone build).

**Rebuild the committed binary whenever `runtime-agent/**` changes:**

```bash
bash scripts/build-agent.sh "$(pwd)/bin/runtime-agent-linux-amd64"
git add bin/runtime-agent-linux-amd64
```

Requires a local Go toolchain (cross-compiles `GOOS=linux GOARCH=amd64`).

> Long-term: bake the agent into the `runtime-computer-v2` image and delete the
> committed binary entirely — see the pt2 spike report.

## Environment variables (Railway → service → Variables)

| Var | Value |
| --- | --- |
| `RUNTIME_PROVIDER` | `daytona` |
| `RUNTIME_BASE_URL` | `https://<your-railway-domain>` (gates same-origin CSRF checks) |
| `RUNTIME_OWNER_GITHUB_LOGIN` | the single GitHub login allowed to sign in |
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase (server-only) |
| `GITHUB_PAT` | fine-grained PAT owned by the owner login; Metadata:R, Contents:R/W, Pull requests:R/W |
| `DAYTONA_API_KEY` | from Daytona |
| `DAYTONA_SNAPSHOT` | `runtime-computer-v1` |
| `RUNTIME_AGENT_BINARY_PATH` | `bin/runtime-agent-linux-amd64` |
| `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` | exactly one |

Optional: `DAYTONA_API_URL`, `DAYTONA_TARGET`. Railway injects `PORT` itself —
don't set it.

## Auth callback wiring

GitHub OAuth runs through Supabase, so:

1. **Supabase → Authentication → URL Configuration:** add
   `https://<your-railway-domain>` to the Site URL / redirect allowlist.
2. **GitHub OAuth app:** callback stays Supabase's `.../auth/v1/callback`; ensure
   it's authorized for any SSO orgs the `GITHUB_PAT` needs.

## Note on `maxDuration` and `outputFileTracingIncludes`

Both are Vercel-serverless concepts and are **inert on Railway**:

- The `maxDuration = 60` exports on the provisioning routes only bind a wall-clock
  on serverless hosts; on a long-running `next start` server they do nothing.
- `outputFileTracingIncludes` in `next.config.ts` only affects `output: 'standalone'`
  bundles; `next start` serves the full build, so the binary is already present.

They're kept as harmless portability (a Vercel fallback still works). Remove them
if you want a Railway-only build with no dead config.

## Pre-deploy checklist

- [ ] `bin/runtime-agent-linux-amd64` is committed and current with `runtime-agent/`.
- [ ] All env vars above are set on the Railway service.
- [ ] Supabase migrations applied (`supabase/migrations/*.sql` in order).
- [ ] Railway domain added to Supabase redirect allowlist.
- [ ] Health check set to `/api/health`.
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` rotated (the earlier one was shared — treat as exposed).

## First-deploy smoke test

1. Sign in as `RUNTIME_OWNER_GITHUB_LOGIN`.
2. Create a workspace on a project → a Runtime Computer provisions (first one is
   the slow ~15s path).
3. Open the workspace → the terminal WS connects directly to Daytona.
4. Close the tab, reopen → the session resumes (Claude kept running).
