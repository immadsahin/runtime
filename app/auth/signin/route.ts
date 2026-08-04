import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { safeRelativePath } from "@/lib/auth/redirect";
import { requireEnv } from "@/lib/env";
import { hoplitePreviewOrigin } from "@/lib/http/preview-origin";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Begin the PKCE OAuth exchange on the server. A normal link to this route
 * works in embedded previews, where an implicit client-side redirect can be
 * suppressed before React has hydrated.
 */
export async function GET(request: NextRequest) {
  const cookiesToSet: Array<{
    name: string;
    value: string;
    options: Parameters<NextResponse["cookies"]["set"]>[2];
  }> = [];

  const supabase = createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value, options } of cookies) {
            cookiesToSet.push({ name, value, options });
          }
        },
      },
    },
  );

  const next = safeRelativePath(request.nextUrl.searchParams.get("next"));
  const redirectTo = new URL(
    "/auth/callback",
    hoplitePreviewOrigin(request) ?? request.nextUrl.origin,
  );
  redirectTo.searchParams.set("next", next);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: redirectTo.toString(),
      scopes: "read:user user:email",
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    const failure = new URL("/signin", request.nextUrl.origin);
    failure.searchParams.set("error", "exchange_failed");
    return NextResponse.redirect(failure);
  }

  const response = NextResponse.redirect(data.url);
  for (const { name, value, options } of cookiesToSet) {
    response.cookies.set(name, value, options);
  }
  return response;
}
