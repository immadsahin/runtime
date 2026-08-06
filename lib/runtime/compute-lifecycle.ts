import type { Workspace } from "@/lib/runtime/types";

/**
 * Agent target lookup must not happen for a suspended workspace: E2B's target
 * lookup reconnects its paused sandbox, which would bypass lifecycle resume.
 */
export function hasActiveComputeWorkspace(workspace: Pick<Workspace, "status">): boolean {
  return workspace.status === "ready" || workspace.status === "idle";
}
