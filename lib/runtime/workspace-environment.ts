import { optionalEnv } from "@/lib/env";

/** Used only for the short-lived clone/push operation, never a Claude job. */
export function workspaceCloneEnvironment(): Record<string, string> {
  const token = optionalEnv("GITHUB_PAT");
  return token ? { GITHUB_PAT: token } : {};
}
