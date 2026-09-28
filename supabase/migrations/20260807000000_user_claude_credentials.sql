-- Per-user Claude Code credentials (multi-tenant: bring-your-own subscription).
--
-- Stores each owner's `claude setup-token` OAuth token, encrypted at rest by
-- the application (AES-256-GCM; see lib/crypto/secret-box.ts). When present, a
-- user's token fully replaces the platform Claude credentials for their
-- sandboxes (see runtimeSessionEnvironment).
--
-- Security model: the ciphertext must never reach the browser. RLS is enabled
-- with NO policies, so the anon/authenticated roles can select zero rows. Only
-- the service-role client (lib/supabase/server.ts -> createSupabaseAdminClient),
-- which bypasses RLS, reads or writes this table, and it does so exclusively on
-- the authenticated owner's behalf.

create table user_claude_credentials (
  owner_id uuid primary key references auth.users (id) on delete cascade,

  -- Version-tagged AES-256-GCM payload: "v1:<iv>:<tag>:<ciphertext>".
  token_ciphertext text not null,
  -- Last 4 chars only, so the UI can confirm which token without decrypting.
  token_last4 text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_claude_credentials enable row level security;

-- Intentionally no policies: the anon/authenticated roles get zero rows. The
-- service-role key (used only by trusted server code) bypasses RLS entirely.

create trigger user_claude_credentials_set_updated_at
  before update on user_claude_credentials
  for each row execute function set_updated_at();
