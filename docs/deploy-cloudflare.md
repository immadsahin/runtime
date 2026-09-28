# Deploying Runtime/Outrunner to Cloudflare Containers

This is a **provider swap** of the existing Railway deployment — the application
code is unchanged. Cloudflare Containers runs the same `next start` container, so
the filesystem, Node runtime, and the on-disk `bin/runtime-agent-linux-amd64`
read all work exactly as on Railway. **Railway stays intact**; this deploys
alongside it until you cut the domain over.

> Why Containers and not Workers/Pages: the control plane reads the agent binary
> from disk and provisions synchronously in-request. Workers have no filesystem
> and a serverless model that fights both. Containers keep the setup as-is. See
> the Railway doc for the same reasoning in reverse: `docs/deploy-railway.md`.

## What was pre-built for you

| File | Purpose |
| --- | --- |
| `Dockerfile` | Builds the control-plane image (`next start`, whole app on disk). |
| `.dockerignore` | Keeps the image lean and **keeps secrets/`.env*` out of it**. |
| `cloudflare/wrangler.jsonc` | Container + Durable Object + custom-domain config. |
| `cloudflare/worker.ts` | Thin Worker that forwards all requests to the container. |
| `cloudflare/package.json` | Deploy tooling (`wrangler`, `@cloudflare/containers`), isolated from the app. |

Account + zone (already looked up, not secret):

- **Account id:** `573a49a12e65fd8fc97b0103fa200d36` (Neevcode@neevcloud.com)
- **`neev.ai` zone id:** `4025edd7b4e5bf2fea54e245dc21427e` (active, on Cloudflare NS)
- **Domain:** `outrunner.neev.ai` (was `runtime.zero`)

## ⚠️ The API token

The Cloudflare token was shared in chat, so **treat it as exposed and rotate it**.
It is **not** stored in this repo. Provide it to `wrangler` at deploy time via the
environment only:

```bash
export CLOUDFLARE_API_TOKEN='<your-rotated-token>'
export CLOUDFLARE_ACCOUNT_ID='573a49a12e65fd8fc97b0103fa200d36'
```

The token needs write scopes for **Workers Scripts**, **Cloudflare Containers**,
**Durable Objects**, and **DNS (edit) on the neev.ai zone**. The provided token
verified for read access; confirm/add these scopes before deploying.

## One-time setup

```bash
cd cloudflare
pnpm install            # resolves wrangler + @cloudflare/containers, writes a local lockfile
pnpm dlx wrangler login # or rely on CLOUDFLARE_API_TOKEN from the environment
```

## Environment variables (set as Worker secrets)

These mirror the Railway "Variables" table. **Secrets** are set with
`wrangler secret put` and are forwarded into the container by
`cloudflare/worker.ts`. Non-secret config (`RUNTIME_PROVIDER`,
`RUNTIME_BASE_URL`, `RUNTIME_AGENT_BINARY_PATH`, `DAYTONA_SNAPSHOT`) is already
inline in `worker.ts`.

```bash
cd cloudflare
for s in \
  NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_ANON_KEY \
  SUPABASE_SERVICE_ROLE_KEY \
  GITHUB_PAT \
  DAYTONA_API_KEY \
  RUNTIME_OWNER_GITHUB_LOGIN \
  CLAUDE_CODE_OAUTH_TOKEN ; do
  pnpm dlx wrangler secret put "$s"
done
# Set ANTHROPIC_API_KEY instead of CLAUDE_CODE_OAUTH_TOKEN if that's your auth.
# Optional: DAYTONA_API_URL, DAYTONA_TARGET.
```

`RUNTIME_BASE_URL` is set to `https://outrunner.neev.ai` in `worker.ts`. It also
gates the app's same-origin CSRF checks, so it **must** equal the live domain.

## Domain change: `runtime.zero` → `outrunner.neev.ai`

The domain is deployment config, not code. Three places:

1. **Cloudflare DNS/route** — handled by the `routes` entry in `wrangler.jsonc`
   (`custom_domain: true`). Deploying creates/points `outrunner.neev.ai` in the
   neev.ai zone automatically.
2. **`RUNTIME_BASE_URL`** — `https://outrunner.neev.ai` (already in `worker.ts`).
3. **Supabase → Authentication → URL Configuration** — add
   `https://outrunner.neev.ai` to the Site URL and the redirect allowlist.
   (GitHub OAuth callback stays Supabase's `.../auth/v1/callback` — unchanged.)

## Deploy

```bash
cd cloudflare
pnpm dlx wrangler deploy
```

This builds the image from `../Dockerfile`, pushes it, and wires the Worker +
Durable Object + `outrunner.neev.ai`.

## Pre-deploy checklist

- [ ] Token **rotated**, and scoped for Workers + Containers + Durable Objects + neev.ai DNS.
- [ ] `bin/runtime-agent-linux-amd64` committed and current with `runtime-agent/` (`bash scripts/build-agent.sh "$(pwd)/bin/runtime-agent-linux-amd64"`).
- [ ] All secrets set via `wrangler secret put`.
- [ ] `https://outrunner.neev.ai` added to Supabase redirect allowlist.
- [ ] Supabase migrations applied (shared with Railway — same project, no change).

## First-deploy smoke test

1. Hit `https://outrunner.neev.ai/api/health` → healthy.
2. Sign in as `RUNTIME_OWNER_GITHUB_LOGIN`.
3. Create a workspace → a Runtime Computer provisions; open it → the terminal WS
   connects **directly to Daytona** (unchanged by the host swap).
4. Close/reopen the tab → session resumes.

## Caveats vs Railway (behavioral, not code)

- **Idle sleep → cold start.** Containers sleep after inactivity (`sleepAfter`
  in `worker.ts`, default 20m). Raise it, or keep a warm instance, if first-hit
  latency after idle matters. Railway keeps the container always-on.
- **Verify the fast-moving bits.** The `containers` wrangler schema and the
  `@cloudflare/containers` API (`defaultPort`, `sleepAfter`, `envVars`,
  `instance_type`, `getContainer`) change; confirm against current docs before
  the first deploy. `worker.ts` / `wrangler.jsonc` are scaffolding.
- **Instance sizing / regions / pricing** — check `instance_type` fits a thin
  orchestrator and that Container regions cover your users.

## Rollback

Railway is untouched. To roll back, point `outrunner.neev.ai` (or your prior
domain) back at the Railway service and set its `RUNTIME_BASE_URL` accordingly.
