# Deploying Runtime to Vercel

Runtime's control plane (this Next.js app) hosts fine on Vercel. Supabase (auth +
Postgres + Storage) and Daytona (the Runtime Computers) are managed services, so
Vercel is the only thing you deploy.

The one thing Vercel does **not** carry is the live terminal: the browser opens a
WebSocket **directly to the Daytona signed preview URL**, never through Vercel
(`docs/architecture/runtime-v1-plan.md`, decision 1A). So the platform's lack of
long-lived WS support is a non-issue — Vercel only serves short control-plane
requests.

## Plan requirement

**Vercel Pro (or higher) is required.** Lazy provisioning boots a Daytona box +
runtime-agent (~15s) and mirrors the repo, which exceeds the **10s Hobby function
cap**. The provisioning routes set `maxDuration = 60`; that ceiling is only
available on Pro.

## The agent binary (why the extra build step exists)

On each provision the Daytona provider reads the cross-compiled `runtime-agent`
binary and uploads it to the box (`lib/runtime/daytona-provider.ts` →
`lib/runtime/daytona/deploy.ts`). Two consequences on Vercel:

1. The default build output (`.context/build/…`) is gitignored, so it is not in
   the deploy source. We commit a tracked copy at `bin/runtime-agent-linux-amd64`.
2. The path is computed at request time, so Next's file tracer cannot follow it.
   `next.config.ts` → `outputFileTracingIncludes` force-bundles the binary into
   the provisioning functions.

**Rebuild the committed binary whenever `runtime-agent/**` changes:**

```bash
bash scripts/build-agent.sh "$(pwd)/bin/runtime-agent-linux-amd64"
git add bin/runtime-agent-linux-amd64
```

Requires a Go toolchain locally (the binary is cross-compiled `GOOS=linux
GOARCH=amd64`); Vercel's build image has no reliable Go, which is why we commit
the artifact rather than build it during `vercel build`.

> Long-term: bake the agent into the `runtime-computer-v2` image and delete both
> the committed binary and the `outputFileTracingIncludes` entry — see the pt2
> spike report.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Var | Value |
| --- | --- |
| `RUNTIME_PROVIDER` | `daytona` |
| `RUNTIME_BASE_URL` | `https://<your-prod-domain>` (gates same-origin CSRF checks) |
| `RUNTIME_OWNER_GITHUB_LOGIN` | the single GitHub login allowed to sign in |
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase (server-only) |
| `GITHUB_PAT` | fine-grained PAT owned by the owner login; Metadata:R, Contents:R/W, Pull requests:R/W |
| `DAYTONA_API_KEY` | from Daytona |
| `DAYTONA_SNAPSHOT` | `runtime-computer-v1` |
| `RUNTIME_AGENT_BINARY_PATH` | `bin/runtime-agent-linux-amd64` |
| `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` | exactly one |

Optional: `DAYTONA_API_URL`, `DAYTONA_TARGET`.

## Auth callback wiring

GitHub OAuth runs through Supabase, so:

1. **Supabase → Authentication → URL Configuration:** add
   `https://<your-prod-domain>` to the Site URL / redirect allowlist.
2. **GitHub OAuth app:** the callback URL points at Supabase's
   `.../auth/v1/callback` (unchanged from local), but make sure the app is
   authorized for any SSO orgs the `GITHUB_PAT` needs.

## Pre-deploy checklist

- [ ] `bin/runtime-agent-linux-amd64` is committed and current with `runtime-agent/`.
- [ ] Vercel plan is Pro (for `maxDuration = 60`).
- [ ] All env vars above are set for the Production environment.
- [ ] Supabase migrations applied (`supabase/migrations/*.sql` in order).
- [ ] Prod domain added to Supabase redirect allowlist.
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` rotated (the earlier one was shared — treat as exposed).
- [ ] Daytona API key lives in Vercel's secret store, not in the repo.

## First-deploy smoke test

1. Sign in as `RUNTIME_OWNER_GITHUB_LOGIN`.
2. Create a workspace on a project → confirm a Runtime Computer provisions
   (first one is the slow ~15s path; watch it complete under the 60s cap).
3. Open the workspace → the terminal WS should connect directly to Daytona.
4. Close the tab, reopen → the session resumes (Claude kept running).
