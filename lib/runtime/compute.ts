/**
 * Workspace compute service.
 *
 * {@link ensureLiveSandbox} guarantees live compute before running work,
 * transparently resuming a suspended/expired workspace. Kept out of the route
 * handlers, and dependency-injected (no direct DB or provider imports), so every
 * branch can be driven from tests with in-memory fakes. The interactive session
 * routes reuse it (Phase 0 decision).
 */
import type {
  RuntimeProvider,
  Workspace,
  WorkspaceStatus,
} from "@/lib/runtime/types";

type TransitionWorkspace = (input: {
  id: string;
  from: WorkspaceStatus[];
  patch: {
    status: WorkspaceStatus;
    sandboxId?: string | null;
    errorMessage?: string | null;
    touchActive?: boolean;
  };
}) => Promise<Workspace | null>;

type ProviderResolution =
  | { ok: true; provider: RuntimeProvider }
  | { ok: false; status: 503 | 409; message: string };

// ---------------------------------------------------------------------------
// Ensure live sandbox (Architecture 2A)
// ---------------------------------------------------------------------------

export type EnsureSandboxDeps = {
  resolveProvider: (workspace: Workspace) => ProviderResolution;
  transitionWorkspace: TransitionWorkspace;
};

export type EnsureSandboxResult =
  | { ok: true; provider: RuntimeProvider; sandboxId: string }
  | { ok: false; status: number; message: string };

/** States from which we may (re)start compute onto the durable volume. */
const RESUMABLE: WorkspaceStatus[] = ["ready", "idle", "suspended"];

/**
 * Return a provider + a live sandbox id for the workspace, resuming onto fresh
 * compute if the recorded sandbox is missing or expired. The `resuming`
 * transition is an optimistic guard: only one caller can claim it, so two tabs
 * cannot spawn two sandboxes. On resume failure the workspace is restored to its
 * prior state with an error message.
 */
export async function ensureLiveSandbox(
  workspace: Workspace,
  deps: EnsureSandboxDeps,
): Promise<EnsureSandboxResult> {
  const resolution = deps.resolveProvider(workspace);
  if (!resolution.ok) return resolution;
  const provider = resolution.provider;

  // Fast path: a live sandbox is already attached.
  if (workspace.sandboxId && (await provider.sandboxAlive(workspace.sandboxId))) {
    return { ok: true, provider, sandboxId: workspace.sandboxId };
  }

  if (!workspace.volumeName) {
    return {
      ok: false,
      status: 409,
      message: "This workspace has no persistent storage to start compute from.",
    };
  }

  const claimed = await deps.transitionWorkspace({
    id: workspace.id,
    from: RESUMABLE,
    patch: { status: "resuming", errorMessage: null },
  });
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      message: "This workspace is changing state. Refresh and try again.",
    };
  }

  try {
    const { sandboxId } = await provider.resumeWorkspace({
      workspaceId: workspace.id,
      volumeName: workspace.volumeName,
      env: {},
    });
    const settled = await deps.transitionWorkspace({
      id: workspace.id,
      from: ["resuming"],
      patch: { status: "ready", sandboxId, errorMessage: null, touchActive: true },
    });
    if (!settled) {
      return {
        ok: false,
        status: 409,
        message: "This workspace changed during startup. Refresh and try again.",
      };
    }
    return { ok: true, provider, sandboxId };
  } catch (error) {
    console.error(`Workspace ${workspace.id} auto-resume failed`, error);
    await deps
      .transitionWorkspace({
        id: workspace.id,
        from: ["resuming"],
        patch: {
          status: workspace.status,
          errorMessage: "Could not start compute. Check Runtime setup and try again.",
        },
      })
      .catch((restoreError: unknown) =>
        console.error(
          `Workspace ${workspace.id} could not be restored after resume failure`,
          restoreError,
        ),
      );
    return {
      ok: false,
      status: 502,
      message: "Could not start compute for this workspace. Try again.",
    };
  }
}
