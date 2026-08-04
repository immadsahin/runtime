import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Every application table required for Runtime's initial control plane. */
export const RUNTIME_TABLES = ["projects", "workspaces", "jobs", "pull_requests"] as const;

export type RuntimeTable = (typeof RUNTIME_TABLES)[number];
export type TableProbeStatus = "ok" | "missing" | "unreachable";
export type DatabaseProbe = Record<RuntimeTable, TableProbeStatus>;

/**
 * Verify that the schema required by Runtime is reachable.
 *
 * Responses deliberately use stable diagnostic labels. The underlying
 * Supabase/network error is logged only on the server, so public endpoints do
 * not disclose connection details or provider error messages.
 */
export async function probeRuntimeDatabase(): Promise<DatabaseProbe> {
  const result = Object.fromEntries(
    RUNTIME_TABLES.map((table) => [table, "unreachable"]),
  ) as DatabaseProbe;

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch (error) {
    console.error("Runtime database probe could not create a Supabase client", error);
    return result;
  }

  for (const table of RUNTIME_TABLES) {
    try {
      // Do not use a HEAD request: PostgREST can omit the useful error body,
      // which made an absent migration look healthy in earlier checks.
      const { error } = await supabase.from(table).select("id").limit(1);
      if (!error) {
        result[table] = "ok";
      } else if (error.code === "PGRST205" || error.code === "42P01") {
        result[table] = "missing";
      } else {
        console.error(`Runtime database probe failed for ${table}`, error);
      }
    } catch (error) {
      console.error(`Runtime database probe threw for ${table}`, error);
    }
  }

  return result;
}
