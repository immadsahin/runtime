import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh (Next.js 16 renamed `middleware` to `proxy`).
 *
 * Supabase access tokens expire hourly. Without a refresh here, Server
 * Components see an expired token and treat the owner as signed out even while
 * the browser still looks logged in.
 */
export async function proxy(request: NextRequest) {
  // Older Supabase redirect settings can send the authorization code to the
  // site root instead of the requested `/auth/callback` URL. Recover it at
  // the edge before rendering the page (or refreshing a session), so the code
  // always reaches the PKCE exchange handler rather than producing a generic
  // application error at `/?code=…`.
  if (
    request.nextUrl.pathname === "/" &&
    (request.nextUrl.searchParams.has("code") ||
      request.nextUrl.searchParams.has("error"))
  ) {
    const callback = request.nextUrl.clone();
    callback.pathname = "/auth/callback";
    return NextResponse.redirect(callback);
  }

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Before Supabase is configured the app still needs to boot and render.
  if (!url || !key) return response;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    // Touching getUser() is what performs the refresh; do not remove.
    await supabase.auth.getUser();
  } catch (error) {
    // Configuration diagnostics must remain reachable if the URL/key is bad.
    console.error("Supabase session refresh was skipped", error);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
