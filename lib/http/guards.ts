import { optionalEnv } from "@/lib/env";
import { hoplitePreviewOrigin } from "@/lib/http/preview-origin";

/**
 * Reject cross-site writes. A mutating request must carry an `Origin` header
 * whose origin matches the configured `RUNTIME_BASE_URL`. Runtime is a
 * single-user, same-origin app, so this is the entire CSRF defense.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  // A local development server may be started on a different port than a
  // stale RUNTIME_BASE_URL value. The browser request URL is the authoritative
  // same-origin boundary in development. Preview requests use their validated
  // forwarded host because Next receives them through the local tunnel.
  const previewOrigin = hoplitePreviewOrigin(request);
  const expectedOrigin =
    previewOrigin ??
    (process.env.NODE_ENV !== "production" ? requestOrigin : optionalEnv("RUNTIME_BASE_URL"));
  if (!expectedOrigin) return false;

  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}
