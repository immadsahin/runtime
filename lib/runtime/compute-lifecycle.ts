import type { ComputeProvider } from "@/lib/runtime/compute-provider";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";

/**
 * Agent target lookup must not happen for a suspended workspace: E2B's target
 * lookup reconnects its paused sandbox, which would bypass lifecycle resume.
 */
export function hasActiveComputeWorkspace(workspace: Pick<Workspace, "status">): boolean {
  return workspace.status === "ready" || workspace.status === "idle";
}

/**
 * E2B can pause an isolated computer after its configured inactivity timeout.
 * Detect that state before asking the provider for an agent target because an
 * E2B attach resumes the sandbox. Callers persist `suspended` before returning
 * so the explicit Resume control replaces a silent restart on a read.
 */
export async function isAutoPausedComputeWorkspace(
  computer: Pick<RuntimeComputer, "providerComputerId">,
  provider: Pick<ComputeProvider, "topology" | "computerState">,
): Promise<boolean> {
  if (provider.topology !== "isolated" || !computer.providerComputerId) return false;
  return (await provider.computerState(computer.providerComputerId)) === "paused";
}
