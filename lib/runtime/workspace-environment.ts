import { optionalEnv } from "@/lib/env";

function configuredEnvironment(
  keys: readonly ("GITHUB_PAT" | "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN")[],
): Record<string, string> {

  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = optionalEnv(key);
      return value ? [[key, value]] : [];
    }),
  );
}

/** Used only for the short-lived clone/push operation, never a Claude job. */
export function workspaceCloneEnvironment(): Record<string, string> {
  return configuredEnvironment(["GITHUB_PAT"]);
}

/**
 * The narrow, server-only environment injected into one Claude invocation.
 * GitHub write credentials are deliberately excluded: Claude can edit a
 * repository, but Runtime performs the explicit commit/push/PR operations.
 */
export function claudeJobEnvironment(): Record<string, string> {
  return configuredEnvironment(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
}

/** Credential values that must never reach browser-visible terminal output. */
export function claudeJobSecrets(): string[] {
  return Object.values(claudeJobEnvironment());
}
