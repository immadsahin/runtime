# Supabase

Project ref: `lnefgozarjjuyztnmnkp`

## Applying migrations

The sandbox has no IPv6 egress and `db.<ref>.supabase.co` resolves to an
IPv6-only address, so a direct `psql` connection from here fails with
"Network is unreachable". Use one of these instead.

### Option A — SQL editor (no local setup)

Paste each file in `supabase/migrations/` into the Supabase SQL editor, oldest
first, and run it.

### Option B — Supabase CLI (from your laptop)

The CLI is already a dev dependency, so use `pnpm supabase` rather than a
global install:

```bash
pnpm supabase login
pnpm supabase link --project-ref lnefgozarjjuyztnmnkp
pnpm supabase db push
```

Notes:

- Do **not** run `supabase init` — this repository already contains
  `supabase/migrations`, and `init` would scaffold a competing config.
- `db push` applies pending migrations. `supabase db reset` is destructive.
- Connecting through the CLI uses the pooler, which works over IPv4.

## Verifying the schema

Before touching the hosted project, validate migrations against a throwaway
local Postgres:

```bash
./scripts/verify-migrations.sh
```

This applies every migration and asserts the constraints and RLS policies. It
exits non-zero if a guarantee regresses.

## Auth configuration (dashboard, one-time)

1. **Authentication → Providers → GitHub**: enable it and paste the GitHub
   OAuth app's client ID and secret.
2. Set the GitHub OAuth app's callback URL to:
   `https://lnefgozarjjuyztnmnkp.supabase.co/auth/v1/callback`
3. **Authentication → URL Configuration**: add `<app-origin>/auth/callback`
   (for example `http://localhost:3000/auth/callback`) to the Redirect URLs
   allowlist.

`/setup` in the running app reports which of these are satisfied.
