import type { ComputeProvider } from "@/lib/runtime/compute-provider";
import type { RuntimeComputer, Workspace, WorkspaceStatus } from "@/lib/runtime/types";

export const AUTO_PAUSE_MESSAGE =
  "Runtime Computer paused after inactivity. Resume the workspace to continue.";

/**
 * A paused provider resource should only replace an active workspace state.
 * Polling requests can race with archive, restore, suspend, or destroy; their
 * transition state is authoritative and must never be overwritten by a stale
 * observation that the E2B computer is paused.
 */
export function autoPauseWorkspaceTransition(id: string): {
  id: string;
  from: WorkspaceStatus[];
  patch: { status: WorkspaceStatus; errorMessage: string };
} {
  return {
    id,
    from: ["ready", "idle"],
    patch: { status: "suspended", errorMessage: AUTO_PAUSE_MESSAGE },
  };
}

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

/**
 * An archived isolated workspace retains its immutable placement, but it must
 * not continue consuming running compute after its Snapshot is durable. The
 * corresponding Restore action reconnects this exact provider handle.
 */
export async function pauseArchivedIsolatedComputer(
  computer: Pick<RuntimeComputer, "providerComputerId">,
  provider: Pick<ComputeProvider, "topology" | "pauseComputer">,
): Promise<void> {
  if (provider.topology !== "isolated") return;
  if (!computer.providerComputerId) {
    throw new Error("Isolated Runtime Computer has no provider computer id.");
  }
  await provider.pauseComputer(computer.providerComputerId);
}
