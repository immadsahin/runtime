/**
 * Central environment access.
 *
 * Runtime is a single-user system, so configuration is intentionally flat:
 * everything is read from process.env and validated lazily at the call site
 * rather than at import time (so `next build` works without secrets).
 */

type EnvKey =
  // Supabase
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "SUPABASE_SERVICE_ROLE_KEY"
  // Single-user guard
  | "RUNTIME_OWNER_GITHUB_LOGIN"
  // GitHub (git + API operations performed inside workspaces)
  | "GITHUB_PAT"
  // Linear
  | "LINEAR_CLIENT_ID"
  | "LINEAR_CLIENT_SECRET"
  // Modal
  | "MODAL_TOKEN_ID"
  | "MODAL_TOKEN_SECRET"
  | "MODAL_APP_NAME"
  // Claude Code
  | "ANTHROPIC_API_KEY"
  | "CLAUDE_CODE_OAUTH_TOKEN"
  // Codex
  | "CODEX_API_KEY"
  // Provider selection
  | "RUNTIME_PROVIDER"
  | "RUNTIME_BASE_URL";

export function optionalEnv(key: EnvKey): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export function requireEnv(key: EnvKey): string {
  const value = optionalEnv(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. See .env.example.`,
    );
  }
  return value;
}

/** Which RuntimeProvider implementation to use. */
export function providerName(): "local" | "modal" {
  const provider = optionalEnv("RUNTIME_PROVIDER") ?? "local";
  if (provider === "local" || provider === "modal") return provider;
  throw new Error(
    `Invalid RUNTIME_PROVIDER "${provider}". Expected "local" or "modal".`,
  );
}
