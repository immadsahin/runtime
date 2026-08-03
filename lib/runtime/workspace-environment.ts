import { optionalEnv } from "@/lib/env";

/**
 * The narrow, server-only environment a provider may inject into a workspace.
 * These values are never returned to the browser or persisted in Supabase.
 */
export function workspaceRuntimeEnvironment(): Record<string, string> {
  const keys = [
    "GITHUB_PAT",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const;

  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = optionalEnv(key);
      return value ? [[key, value]] : [];
    }),
  );
}
