#!/usr/bin/env bash
# Apply supabase/migrations/*.sql to a throwaway local Postgres and assert the
# constraints and RLS policies behave as intended.
#
# This exists so schema changes are validated before they touch the real
# Supabase project. Requires local postgres (installed by the setup script).
set -euo pipefail

PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
DB=${DB:-runtime_verify}
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

run_psql() { sudo -u postgres psql -q "$@"; }

if ! sudo -u postgres "$PG_BIN/pg_ctl" -D /var/lib/postgresql/16/main status >/dev/null 2>&1; then
  echo "==> starting postgres"
  sudo -u postgres "$PG_BIN/pg_ctl" \
    -D /var/lib/postgresql/16/main \
    -l /tmp/pg.log \
    -o "-c config_file=/etc/postgresql/16/main/postgresql.conf" \
    start
  sleep 2
fi

echo "==> recreating $DB"
run_psql -c "drop database if exists $DB;" -c "create database $DB;"

# Minimal stand-ins for the Supabase-managed auth schema.
echo "==> stubbing auth schema"
run_psql -d "$DB" -c "
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as \$\$
    select current_setting('request.jwt.claim.sub', true)::uuid
  \$\$;"

echo "==> applying migrations"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  run_psql -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done

echo "==> asserting constraints and RLS"
run_psql -d "$DB" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/scripts/schema-assertions.sql"

echo "==> OK"
