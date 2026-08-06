/**
 * Central environment access.
 *
 * Runtime is a single-user system, so configuration is intentionally flat:
 * everything is read from process.env and validated lazily at the call site
 * rather than at import time (so `next build` works without secrets).
 */

import type { ProviderName } from "@/lib/runtime/types";

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
  // Daytona (Runtime Computer backend)
  | "DAYTONA_API_KEY"
  | "DAYTONA_API_URL"
  | "DAYTONA_TARGET"
  | "DAYTONA_SNAPSHOT"
  // E2B (isolated Runtime Computer backend)
  | "E2B_API_KEY"
  | "E2B_TEMPLATE"
  | "E2B_SANDBOX_TIMEOUT_MS"
  | "RUNTIME_ENABLE_E2B"
  // Cross-compiled runtime-agent binary uploaded on provision (decision 1A).
  | "RUNTIME_AGENT_BINARY_PATH"
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
export function providerName(): ProviderName {
  const provider = optionalEnv("RUNTIME_PROVIDER") ?? "local";
  if (
    provider === "local" ||
    provider === "modal" ||
    provider === "daytona" ||
    provider === "e2b"
  ) {
    return provider;
  }
  throw new Error(
    `Invalid RUNTIME_PROVIDER "${provider}". Expected "local", "modal", "daytona", or "e2b".`,
  );
}

/**
 * E2B remains opt-in until the pinned Runtime template and browser transport
 * have passed the real-sandbox acceptance suite. Keep this independent of the
 * provider name so a deployment cannot enable E2B accidentally.
 */
export function e2bEnabled(): boolean {
  const enabled = optionalEnv("RUNTIME_ENABLE_E2B");
  if (!enabled || enabled === "false") return false;
  if (enabled === "true") return true;
  throw new Error('RUNTIME_ENABLE_E2B must be either "true" or "false".');
}
