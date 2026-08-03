import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { requireEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 *
 * A fresh client per request — never share one across requests. Cookie access
 * uses getAll/setAll only; the get/set/remove trio is deprecated and causes
 * silent session loss.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. The proxy refreshes the
            // session instead, so this is safe to swallow.
          }
        },
      },
    },
  );
}

/**
 * Service-role client: bypasses RLS. Use only for trusted server-side work
 * that acts on the owner's behalf (background job state transitions, log
 * offset bookkeeping) and never in response to unauthenticated input.
 */
export function createSupabaseAdminClient() {
  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      cookies: { getAll: () => [], setAll: () => {} },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
