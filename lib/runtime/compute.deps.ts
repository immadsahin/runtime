/**
 * Real wiring for the compute service. Kept separate from `compute.ts` so the
 * service stays free of Supabase/Next imports and remains unit-testable.
 */
import { transitionWorkspace } from "@/lib/db/repositories";
import {
  ensureLiveSandbox,
  type EnsureSandboxResult,
} from "@/lib/runtime/compute";
import { resolveProvider } from "@/lib/runtime/resolve";
import type { Workspace } from "@/lib/runtime/types";

/** Guarantee a live sandbox, resuming the workspace if needed. */
export function ensureLiveWorkspaceSandbox(
  workspace: Workspace,
): Promise<EnsureSandboxResult> {
  return ensureLiveSandbox(workspace, { resolveProvider, transitionWorkspace });
}
