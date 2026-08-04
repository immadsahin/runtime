/**
 * Workspace compute service.
 *
 * Two responsibilities that both the job and (future) terminal routes need, kept
 * out of the route handlers so they can be unit-tested in isolation:
 *
 *   - {@link settleRunningJobs}  reconcile jobs that finished while no browser
 *     was streaming their logs (durability: "work continues if you close the app").
 *   - {@link ensureLiveSandbox}  guarantee live compute before running work,
 *     transparently resuming a suspended/expired workspace.
 *
 * Everything is dependency-injected (no direct DB or provider imports) so tests
 * can drive every branch with in-memory fakes.
 */
import type {
  Job,
  JobResult,
  JobStatus,
  RuntimeProvider,
  Workspace,
  WorkspaceStatus,
} from "@/lib/runtime/types";

type TransitionJob = (input: {
  id: string;
  from: JobStatus[];
  patch: {
    status: JobStatus;
    exitCode?: number | null;
    finishedAt?: string | null;
    logBytes?: number;
    sessionId?: string | null;
    costUsd?: number | null;
  };
}) => Promise<Job | null>;

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
// Reconcile running jobs (Architecture 1A)
// ---------------------------------------------------------------------------

export type SettleDeps = {
  listJobs: (workspaceId: string) => Promise<Job[]>;
  getJobResult: (input: {
    workspaceId: string;
    sandboxId: string;
    jobId: string;
    resultPath: string;
  }) => Promise<JobResult | null>;
  transitionJob: TransitionJob;
};

/**
 * Settle any queued/running job whose provider result record already exists.
 *
 * Idempotent and concurrency-safe: `transitionJob` only moves a job that is
 * still queued/running, so a concurrent reader — or a live SSE stream doing the
 * same reconciliation — can never double-write or clobber a terminal state.
 * Provider read failures are swallowed so the workspace page still renders; the
 * job simply settles on a later read.
 */
export async function settleRunningJobs(
  workspace: Pick<Workspace, "id" | "sandboxId">,
  deps: SettleDeps,
): Promise<void> {
  const jobs = await deps.listJobs(workspace.id);
  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  if (active.length === 0) return;

  const sandboxId = workspace.sandboxId ?? "";
  await Promise.all(
    active.map(async (job) => {
      if (!job.resultPath) return;
      let result: JobResult | null;
      try {
        result = await deps.getJobResult({
          workspaceId: workspace.id,
          sandboxId,
          jobId: job.id,
          resultPath: job.resultPath,
        });
      } catch {
        return; // provider unreachable / invalid path: settle on a later read
      }
      if (!result) return;
      await deps.transitionJob({
        id: job.id,
        from: ["queued", "running"],
        patch: {
          status: result.status,
          exitCode: result.exitCode,
          finishedAt: result.finishedAt,
          logBytes: job.logBytes,
          ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        },
      });
    }),
  );
}

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
