import { NextResponse } from "next/server";

import { optionalEnv, providerName } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
  };

  // Prove the schema is reachable with the current keys.
  let database: { ok: boolean; error?: string } = {
    ok: false,
    error: "not configured",
  };

  if (configured.supabase) {
    try {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase
        .from("projects")
        .select("id", { head: true, count: "exact" });
      database = error ? { ok: false, error: error.message } : { ok: true };
    } catch (err) {
      database = {
        ok: false,
        error: err instanceof Error ? err.message : "unknown error",
      };
    }
  }

  return NextResponse.json({
    ok: configured.supabase && database.ok,
    provider: providerName(),
    configured,
    database,
    time: new Date().toISOString(),
  });
}
