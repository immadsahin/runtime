import { optionalEnv } from "@/lib/env";

/**
 * Reject cross-site writes. A mutating request must carry an `Origin` header
 * whose origin matches the configured `RUNTIME_BASE_URL`. Runtime is a
 * single-user, same-origin app, so this is the entire CSRF defense.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const baseUrl = optionalEnv("RUNTIME_BASE_URL");
  if (!baseUrl) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}
