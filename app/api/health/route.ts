import { NextResponse } from "next/server";

import { optionalEnv, providerName } from "@/lib/env";
import {
  probeRuntimeDatabase,
  RUNTIME_TABLES,
  type TableProbeStatus,
} from "@/lib/supabase/probe";

export const dynamic = "force-dynamic";

/**
 * Configuration and connectivity report. Deliberately exposes only booleans
 * about which secrets are present, never their values.
 */
export async function GET() {
  const configured = {
    supabase:
      Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_URL")) &&
      Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")),
    supabaseServiceRole: Boolean(optionalEnv("SUPABASE_SERVICE_ROLE_KEY")),
    ownerLogin: Boolean(optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN")),
    githubPat: Boolean(optionalEnv("GITHUB_PAT")),
    linear:
      Boolean(optionalEnv("LINEAR_CLIENT_ID")) &&
      Boolean(optionalEnv("LINEAR_CLIENT_SECRET")),
    modal:
      Boolean(optionalEnv("MODAL_TOKEN_ID")) &&
      Boolean(optionalEnv("MODAL_TOKEN_SECRET")),
    claude:
      Boolean(optionalEnv("ANTHROPIC_API_KEY")) ||
      Boolean(optionalEnv("CLAUDE_CODE_OAUTH_TOKEN")),
    codex: Boolean(optionalEnv("CODEX_API_KEY")),
  };

  /**
   * Probe every table the app depends on.
   *
   * Deliberately NOT using `{ head: true }`: a HEAD probe can come back
   * without a usable error body, which previously made a missing schema look
   * healthy. A real (limited) select surfaces PostgREST's PGRST205
   * "table not found in schema cache" so an un-run migration is reported
   * honestly.
   */
  const database: {
    ok: boolean;
    migrated: boolean;
    tables: Record<string, TableProbeStatus | "not configured">;
  } = { ok: false, migrated: false, tables: {} };

  if (!configured.supabase) {
    database.tables = Object.fromEntries(
      RUNTIME_TABLES.map((t) => [t, "not configured"]),
    );
  } else {
    database.tables = await probeRuntimeDatabase();
    database.migrated = RUNTIME_TABLES.every(
      (table) => database.tables[table] === "ok",
    );
    database.ok = database.migrated;
  }

  const ok = configured.supabase && database.ok;

  // Point operators at the actual blocker: credentials come before migrations.
  const nextStep = !configured.supabase
    ? "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, then reload."
    : !database.migrated
      ? "Run supabase/migrations/*.sql in the Supabase SQL editor, then reload."
      : null;

  return NextResponse.json(
    {
      ok,
      provider: providerName(),
      configured,
      database,
      ...(nextStep ? { nextStep } : {}),
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
