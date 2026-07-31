import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * GitHub OAuth callback.
 *
 * The browser starts the PKCE flow with `signInWithOAuth`; GitHub (via
 * Supabase) redirects back here with a `code`. We exchange it for a session
 * — which sets the auth cookies on this response — then enforce the
 * single-owner allowlist before letting anyone in.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const next = safeRelativePath(searchParams.get("next"));

  // GitHub/Supabase can bounce back with an error instead of a code
  // (user cancelled, provider misconfigured).
  const providerError =
    searchParams.get("error_description") ?? searchParams.get("error");
  if (providerError) return signInError(origin, providerError);

  const code = searchParams.get("code");
  if (!code) return signInError(origin, "missing_code");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return signInError(origin, error?.message ?? "exchange_failed");
  }

  // Single-user by design: anyone who is not the configured owner is signed
  // straight back out. This is the whole authorization model.
  if (!isOwner(data.user)) {
    await supabase.auth.signOut();
    return signInError(origin, "not_owner");
  }

  // Behind the preview tunnel / a load balancer the request origin is the
  // internal host; honour the forwarded host so the redirect lands back on
  // the URL the user actually came from.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const base =
    process.env.NODE_ENV === "production" && forwardedHost
      ? `https://${forwardedHost}`
      : origin;

  return NextResponse.redirect(`${base}${next}`);
}

function signInError(origin: string, reason: string): NextResponse {
  const url = new URL("/signin", origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}
