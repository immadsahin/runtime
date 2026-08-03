#!/usr/bin/env bash
# Apply supabase/migrations/*.sql to a throwaway local Postgres and assert the
# constraints and RLS policies behave as intended.
#
# This exists so schema changes are validated before they touch the real
# Supabase project. Requires local postgres (installed by the setup script).
set -euo pipefail

PG_BIN=${PG_BIN:-$(pg_config --bindir)}
PG_DATA=${PG_DATA:-}
PG_CONFIG=${PG_CONFIG:-}
PG_OS_USER=${PG_OS_USER:-postgres}
DB=${DB:-runtime_verify}
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

run_as_postgres() {
  if [ "$(id -un)" = "$PG_OS_USER" ]; then
    "$@"
  else
    sudo -u "$PG_OS_USER" "$@"
  fi
}

run_psql() { run_as_postgres "$PG_BIN/psql" -q "$@"; }

if ! run_as_postgres "$PG_BIN/pg_isready" -q; then
  echo "==> starting postgres"
  if [ -n "$PG_DATA" ]; then
    pg_opts=()
    if [ -n "$PG_CONFIG" ]; then
      pg_opts=(-o "-c config_file=$PG_CONFIG")
    fi
    run_as_postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" -l /tmp/runtime-pg.log "${pg_opts[@]}" start
  elif command -v pg_lsclusters >/dev/null 2>&1; then
    read -r version cluster _ < <(pg_lsclusters --no-header | head -n 1)
    if [ -z "${version:-}" ] || [ -z "${cluster:-}" ]; then
      echo "No PostgreSQL cluster found. Set PG_DATA (and optionally PG_CONFIG)." >&2
      exit 1
    fi
    sudo pg_ctlcluster "$version" "$cluster" start
  else
    echo "PostgreSQL is not running. Set PG_DATA (and optionally PG_CONFIG) to start it." >&2
    exit 1
  fi
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
