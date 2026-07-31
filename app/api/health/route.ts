import { NextResponse } from "next/server";

import { optionalEnv, providerName } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TABLES = ["projects", "workspaces", "jobs"] as const;

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
    tables: Record<string, "ok" | "missing" | string>;
  } = { ok: false, migrated: false, tables: {} };

  if (!configured.supabase) {
    database.tables = Object.fromEntries(
      TABLES.map((t) => [t, "not configured"]),
    );
  } else {
    const supabase = await createSupabaseServerClient();

    for (const table of TABLES) {
      try {
        const { error } = await supabase.from(table).select("id").limit(1);
        if (!error) {
          database.tables[table] = "ok";
        } else if (error.code === "PGRST205" || error.code === "42P01") {
          database.tables[table] = "missing";
        } else {
          database.tables[table] = error.message;
        }
      } catch (err) {
        database.tables[table] =
          err instanceof Error ? err.message : "unknown error";
      }
    }

    database.migrated = TABLES.every((t) => database.tables[t] === "ok");
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
