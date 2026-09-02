import { optionalEnv } from "@/lib/env";

/**
 * Reject cross-site writes. A mutating request must carry an `Origin` header
 * whose origin matches the configured `RUNTIME_BASE_URL`. Runtime is a
 * single-user, same-origin app, so this is the entire CSRF defense.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const baseUrl = optionalEnv("RUNTIME_BASE_URL");

  const reject = (reason: string): false => {
    // Diagnostic: surfaces the exact mismatch in server logs. The Origin header
    // is safe to log (no secret); RUNTIME_BASE_URL is non-secret config.
    console.warn(
      `[same-origin] rejected: ${reason} (origin=${JSON.stringify(origin)}, ` +
        `RUNTIME_BASE_URL=${JSON.stringify(baseUrl)})`,
    );
    return false;
  };

  if (!origin) return reject("no Origin header");
  if (!baseUrl) return reject("RUNTIME_BASE_URL unset");
  try {
    if (new URL(origin).origin === new URL(baseUrl).origin) return true;
    return reject("origin does not match RUNTIME_BASE_URL");
  } catch {
    return reject("origin or RUNTIME_BASE_URL is not a valid URL");
  }
}
