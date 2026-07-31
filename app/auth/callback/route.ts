import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";
import { optionalEnv } from "@/lib/env";
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
  const requestUrl = new URL(request.url);
  const base = redirectBase(request, requestUrl);
  const next = safeRelativePath(requestUrl.searchParams.get("next"));

  // GitHub/Supabase can bounce back with an error instead of a code
  // (user cancelled, provider misconfigured).
  const providerError =
    requestUrl.searchParams.get("error_description") ??
    requestUrl.searchParams.get("error");
  if (providerError) return signInError(base, providerError);

  const code = requestUrl.searchParams.get("code");
  if (!code) return signInError(base, "missing_code");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return signInError(base, error?.message ?? "exchange_failed");
  }

  // Single-user by design: anyone who is not the configured owner is signed
  // straight back out. This is the whole authorization model.
  if (!isOwner(data.user)) {
    await supabase.auth.signOut();
    return signInError(base, "not_owner");
  }

  return NextResponse.redirect(`${base}${next}`);
}

/**
 * Absolute origin to redirect back to after the OAuth round trip.
 *
 * Prefer the explicitly configured `RUNTIME_BASE_URL` (the canonical, stable
 * public URL — the correct choice behind a proxy that rewrites the Host). Fall
 * back to the forwarded host in production (the preview tunnel / load balancer
 * sets `x-forwarded-host`), and finally to the request origin in local dev.
 */
function redirectBase(request: Request, requestUrl: URL): string {
  const configured = optionalEnv("RUNTIME_BASE_URL");
  if (configured) return configured.replace(/\/+$/, "");

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (process.env.NODE_ENV === "production" && forwardedHost) {
    return `https://${forwardedHost}`;
  }
  return requestUrl.origin;
}

function signInError(base: string, reason: string): NextResponse {
  const url = new URL(`${base}/signin`);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}
