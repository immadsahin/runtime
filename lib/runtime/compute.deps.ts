/**
 * Real wiring for the compute service. Kept separate from `compute.ts` so the
 * service stays free of Supabase/Next imports and remains unit-testable.
 */
import { listJobs, transitionJob, transitionWorkspace } from "@/lib/db/repositories";
import {
  ensureLiveSandbox,
  settleRunningJobs,
  type EnsureSandboxResult,
} from "@/lib/runtime/compute";
import { resolveProvider } from "@/lib/runtime/resolve";
import type { Workspace } from "@/lib/runtime/types";

/**
 * Reconcile any jobs that finished while the workspace page was closed. Runs on
 * the workspace-detail data path only (bounded to that workspace's jobs) and is
 * best-effort: a missing provider just leaves jobs to settle on a later read.
 */
export async function reconcileWorkspaceJobs(workspace: Workspace): Promise<void> {
  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return;
  const provider = resolution.provider;
  await settleRunningJobs(workspace, {
    listJobs,
    transitionJob,
    getJobResult: (input) => provider.getJobResult(input),
  });
}

/** Guarantee a live sandbox, resuming the workspace if needed. */
export function ensureLiveWorkspaceSandbox(
  workspace: Workspace,
): Promise<EnsureSandboxResult> {
  return ensureLiveSandbox(workspace, { resolveProvider, transitionWorkspace });
}
