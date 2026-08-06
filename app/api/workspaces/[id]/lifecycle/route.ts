import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshots,
  getProject,
  getRuntimeComputer,
  getRuntimeComputerByProject,
  getWorkspace,
  listWorkspaceSnapshots,
  markRuntimeComputerStoppedIfReady,
  readRuntimeComputerSecret,
  transitionWorkspace,
  updateWorkspace,
} from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { runtimeSessionEnvironment } from "@/lib/runtime/ensure-runtime-computer";
import {
  isAutoPausedComputeWorkspace,
  pauseArchivedIsolatedComputer,
} from "@/lib/runtime/compute-lifecycle";
import {
  type ComputeRuntimeProvider,
  isComputeRuntimeProvider,
  providerErrorResponse,
  resolveProvider,
} from "@/lib/runtime/resolve";
import { ensureProjectRuntimeComputer } from "@/lib/runtime/runtime-computer-service";
import { mintSnapshotDownloadUrl, mintSnapshotUpload } from "@/lib/runtime/storage";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { RuntimeProvider, Workspace, WorkspaceStatus } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type LifecycleAction = "resume" | "suspend" | "destroy" | "archive" | "restore";

function actionFor(body: unknown): LifecycleAction | null {
  if (!body || typeof body !== "object" || !("action" in body)) return null;
  const action = body.action;
  return action === "resume" ||
    action === "suspend" ||
    action === "destroy" ||
    action === "archive" ||
    action === "restore"
    ? action
    : null;
}

async function startTransition(
  workspace: Workspace,
  from: WorkspaceStatus[],
  status: WorkspaceStatus,
): Promise<Workspace | null> {
  return transitionWorkspace({
    id: workspace.id,
    from,
    patch: { status, errorMessage: null },
  });
}

async function restoreAfterFailure(
  workspace: Workspace,
  transitionStatus: WorkspaceStatus,
  message: string,
): Promise<void> {
  await transitionWorkspace({
    id: workspace.id,
    from: [transitionStatus],
    patch: { status: workspace.status, errorMessage: message },
  });
}

async function completeTransition(input: {
  id: string;
  from: WorkspaceStatus;
  patch: Parameters<typeof transitionWorkspace>[0]["patch"];
}): Promise<boolean> {
  return Boolean(
    await transitionWorkspace({
      id: input.id,
      from: [input.from],
      patch: input.patch,
    }),
  );
}

function lifecycleError(action: LifecycleAction): string {
  return `Could not ${action} this workspace. Check Runtime setup and try again.`;
}

/** Resume, suspend, or permanently destroy a persisted workspace. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "Sign in as the Runtime owner." },
      { status: 401 },
    );
  }

  let action: LifecycleAction | null = null;
  try {
    action = actionFor(await request.json());
  } catch {
    // Handled below as a deliberately generic bad request.
  }
  if (!action) {
    return NextResponse.json(
      { error: "Use resume, suspend, destroy, archive, or restore." },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;

  if (isComputeRuntimeProvider(provider)) {
    return computeLifecycle(action, workspace, provider, owner.id);
  }

  // Archive/restore operate on the runtime-agent's Session + Snapshot; legacy
  // workspace-per-sandbox providers do not expose that contract.
  if (action === "archive" || action === "restore") {
    return NextResponse.json(
      { error: "Archive and restore are only supported on Runtime workspaces." },
      { status: 409 },
    );
  }
  if (action === "resume") return resumeWorkspace(workspace, provider);
  if (action === "suspend") return suspendWorkspace(workspace, provider);
  return destroyWorkspace(workspace, provider);
}

async function computeLifecycle(
  action: LifecycleAction,
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
) {
  if (action === "resume") return resumeComputeWorkspace(workspace, provider, userId);
  if (action === "suspend") return suspendComputeWorkspace(workspace, provider, userId);
  if (action === "archive") return archiveComputeWorkspace(workspace, provider, userId);
  if (action === "restore") return restoreComputeWorkspace(workspace, provider, userId);
  return destroyComputeWorkspace(workspace, provider, userId);
}

/**
 * Archive → produce a Workspace Snapshot. Next mints one signed upload URL per
 * artifact, the agent captures + uploads them (manifest last) and returns the
 * manifest, then Next caches it on a `workspace_snapshots` row and marks the
 * workspace `archived`. The worktree is intentionally kept (Restore reclaims it
 * later), so an archived workspace is revivable — not destroyed.
 */
async function archiveComputeWorkspace(
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
) {
  if (workspace.status !== "ready" && workspace.status !== "idle") {
    return NextResponse.json(
      { error: "Only an active workspace can be archived." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["ready", "idle"], "archiving");
  if (!transitioned) return lifecycleConflict();

  try {
    const archivedAt = new Date().toISOString();
    const { prefix, urls } = await mintSnapshotUpload(
      supabaseSnapshotStorage(),
      userId,
      workspace.id,
      archivedAt,
    );
    const uploads = urls.map((u) => ({ artifact: u.artifact, url: u.signedUrl }));

    const { agent, identity } = await computeAgent(workspace, provider, userId);
    const manifest = await agent.archiveWorkspace(identity, { archivedAt, uploads });

    await createWorkspaceSnapshot({
      ownerId: userId,
      workspaceId: workspace.id,
      archivedAt,
      storagePath: prefix,
      manifest,
    });

    // Archive preserves the exact E2B placement for Restore, but the durable
    // Snapshot means that isolated compute can stop billing immediately.
    // Keep the workspace active if pausing fails so this action is retryable
    // rather than claiming an archive released a still-running sandbox.
    const computer = await computerForWorkspace(workspace);
    if (!computer) throw new Error("Runtime Computer is not available for archive.");
    await pauseArchivedIsolatedComputer(computer, provider);
  } catch (error) {
    console.error(`Workspace ${workspace.id} archive failed`, error);
    await restoreAfterFailure(workspace, "archiving", lifecycleError("archive")).catch(
      (updateError: unknown) => console.error("Could not persist archive failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("archive") }, { status: 502 });
  }

  const completed = await completeTransition({
    id: workspace.id,
    from: "archiving",
    patch: { status: "archived", errorMessage: null },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "archived" } })
    : lifecycleReconciliationRequired("archive");
}

/**
 * Restore → revive an archived Session from its Snapshot. Ensures a Runtime
 * Computer at its persisted placement (provisioning it if it was destroyed),
 * mints signed download URLs for the tree + conversation, and
 * has the agent rebuild + VERIFY the worktree before relaunching Claude with
 * `--continue`. A verification failure surfaces as an error and leaves the
 * workspace archived rather than half-restored.
 */
async function restoreComputeWorkspace(
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
) {
  if (workspace.status !== "archived") {
    return NextResponse.json(
      { error: "Only an archived workspace can be restored." },
      { status: 409 },
    );
  }
  const snapshot = (await listWorkspaceSnapshots(workspace.id))[0];
  if (!snapshot) {
    return NextResponse.json(
      { error: "This workspace has no Snapshot to restore." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["archived"], "restoring");
  if (!transitioned) return lifecycleConflict();

  try {
    const project = await getProject(workspace.projectId);
    if (!project) throw new Error("Project not found for restore.");
    const githubToken = optionalEnv("GITHUB_PAT");

    // Manifest pointers -> signed download URLs for exactly what the agent needs.
    const storage = supabaseSnapshotStorage();
    const { manifest, storagePath } = snapshot;
    const downloads = await Promise.all(
      (
        [
          { artifact: "bundle", file: manifest.tree.bundle },
          { artifact: "patch", file: manifest.tree.patch },
          { artifact: "conversation", file: manifest.conversation },
        ] as const
      ).map(async ({ artifact, file }) => ({
        artifact,
        url: await mintSnapshotDownloadUrl(storage, `${storagePath}${file}`, userId),
      })),
    );

    // A provider resource can disappear outside Runtime. Release only the
    // exact persisted placement we checked so a concurrent restore preserves
    // the claim RPC's single-provisioner invariant.
    const currentComputer = await computerForWorkspace(workspace);
    if (
      currentComputer?.status === "ready" &&
      currentComputer.providerComputerId &&
      !(await provider.computerAlive(currentComputer.providerComputerId))
    ) {
      await markRuntimeComputerStoppedIfReady(
        currentComputer.id,
        currentComputer.providerComputerId,
      );
    }

    const placement = currentComputer
      ? {
          provider: currentComputer.provider,
          placementKey: currentComputer.placementKey,
          topology: currentComputer.topology,
          imageVersion: currentComputer.imageVersion,
        }
      : provider.topology === "shared"
        ? {
            provider: provider.name,
            placementKey: `project:${project.id}`,
            topology: "shared" as const,
            imageVersion: provider.placementVersion(),
          }
        : {
            provider: provider.name,
            placementKey: `workspace:${workspace.id}`,
            topology: "isolated" as const,
            imageVersion: provider.placementVersion(),
          };

    // Ensure the immutable placement and refresh its mirror before the agent
    // branches from the bundle. A paused isolated computer resumes in place;
    // it is not reprovisioned or moved during Restore.
    const ensured = await ensureProjectRuntimeComputer(provider, {
      projectId: project.id,
      ...placement,
      repoFullName: project.fullName,
      githubToken,
      sessionEnv: runtimeSessionEnvironment(),
    });
    const computer = ensured.computer;
    if (!computer.providerComputerId) {
      throw new Error("Ready Runtime Computer has no provider computer id.");
    }
    if (provider.topology === "isolated" && !ensured.provisioned) {
      await provider.resumeComputer(computer.providerComputerId);
    }
    if (!ensured.provisioned) {
      await provider.fetchMirror(computer.providerComputerId, githubToken);
    }

    const target = await provider.agentTarget(
      computer.providerComputerId,
      ensured.agentSecret,
    );
    const identity: WorkspaceIdentity = {
      workspaceId: workspace.id,
      projectId: project.id,
      computerId: computer.id,
      userId,
    };
    await new AgentClient(target).restoreWorkspace(identity, {
      branch: workspace.branch,
      baseBranch: project.defaultBranch,
      sessionId: manifest.sessionId,
      downloads,
    });

    // Persist the (possibly new) box + session linkage now that the agent has
    // rebuilt and verified the worktree.
    await updateWorkspace(workspace.id, {
      computerId: computer.id,
      tmuxSession: `ws-${workspace.id}`,
      agentWorkspaceId: workspace.id,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} restore failed`, error);
    await restoreAfterFailure(workspace, "restoring", lifecycleError("restore")).catch(
      (updateError: unknown) => console.error("Could not persist restore failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("restore") }, { status: 502 });
  }

  const completed = await completeTransition({
    id: workspace.id,
    from: "restoring",
    patch: { status: "ready", errorMessage: null, touchActive: true },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "ready" } })
    : lifecycleReconciliationRequired("restore");
}

async function computeAgent(
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
): Promise<{ agent: AgentClient; identity: WorkspaceIdentity }> {
  const computer = await computerForWorkspace(workspace);
  if (!computer?.providerComputerId || computer.status !== "ready") {
    throw new Error("Runtime Computer is not available.");
  }
  if (await isAutoPausedComputeWorkspace(computer, provider)) {
    await updateWorkspace(workspace.id, {
      status: "suspended",
      errorMessage: "Runtime Computer paused after inactivity. Resume the workspace to continue.",
    });
    throw new Error("Runtime Computer paused after inactivity; resume the workspace first.");
  }
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) throw new Error("Runtime Computer secret is missing.");
  const target = await provider.agentTarget(computer.providerComputerId, secret);
  return {
    agent: new AgentClient(target),
    identity: {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      computerId: computer.id,
      userId,
    },
  };
}

/** Resolve the persisted placement attached to a workspace. The Daytona
 * fallback covers rows created before workspace.computer_id was populated. */
async function computerForWorkspace(workspace: Workspace) {
  const computer = await (workspace.computerId
    ? getRuntimeComputer(workspace.computerId)
    : workspace.provider === "daytona"
      ? getRuntimeComputerByProject(workspace.projectId)
      : null);
  return computer &&
    computer.projectId === workspace.projectId &&
    computer.provider === workspace.provider
    ? computer
    : null;
}

async function resumeComputeWorkspace(
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
) {
  if (workspace.status !== "suspended") {
    return NextResponse.json(
      { error: "Only a suspended workspace can be resumed." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["suspended"], "resuming");
  if (!transitioned) return lifecycleConflict();
  try {
    const computer = await computerForWorkspace(workspace);
    if (!computer?.providerComputerId) throw new Error("Runtime Computer is not available.");
    if (provider.topology === "isolated") {
      await provider.resumeComputer(computer.providerComputerId);
    }
    const { agent, identity } = await computeAgent(workspace, provider, userId);
    await agent.resumeWorkspace(identity);
  } catch (error) {
    console.error(`Workspace ${workspace.id} resume failed`, error);
    await restoreAfterFailure(workspace, "resuming", lifecycleError("resume")).catch(
      (updateError: unknown) => console.error("Could not persist resume failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("resume") }, { status: 502 });
  }
  const completed = await completeTransition({
    id: workspace.id,
    from: "resuming",
    patch: { status: "ready", errorMessage: null, touchActive: true },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "ready" } })
    : lifecycleReconciliationRequired("resume");
}

async function suspendComputeWorkspace(
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
) {
  if (workspace.status !== "ready" && workspace.status !== "idle") {
    return NextResponse.json(
      { error: "Only an active workspace can be suspended." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["ready", "idle"], "suspending");
  if (!transitioned) return lifecycleConflict();
  try {
    const { agent, identity } = await computeAgent(workspace, provider, userId);
    await agent.stopWorkspace(identity);
    const computer = await computerForWorkspace(workspace);
    if (provider.topology === "isolated" && computer?.providerComputerId) {
      await provider.pauseComputer(computer.providerComputerId);
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} suspend failed`, error);
    await restoreAfterFailure(workspace, "suspending", lifecycleError("suspend")).catch(
      (updateError: unknown) => console.error("Could not persist suspend failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("suspend") }, { status: 502 });
  }
  const completed = await completeTransition({
    id: workspace.id,
    from: "suspending",
    patch: { status: "suspended", errorMessage: null },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "suspended" } })
    : lifecycleReconciliationRequired("suspend");
}

async function destroyComputeWorkspace(
  workspace: Workspace,
  provider: ComputeRuntimeProvider,
  userId: string,
) {
  const destroyable: WorkspaceStatus[] = ["ready", "idle", "suspended", "archived", "failed"];
  if (!destroyable.includes(workspace.status)) {
    return NextResponse.json(
      { error: "This workspace cannot be destroyed while another lifecycle action is running." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, destroyable, "destroying");
  if (!transitioned) return lifecycleConflict();

  // Best-effort worktree teardown: destroy is terminal, and the shared box may
  // already be gone (e.g. destroying an ARCHIVED workspace whose Runtime Computer
  // was reclaimed). A missing, paused, or failed agent must not block the
  // durable cleanup. In particular, detecting an E2B timeout pause here must
  // not overwrite the in-progress `destroying` state: destroy can kill a
  // paused sandbox without reconnecting it.
  try {
    const computer = await computerForWorkspace(workspace);
    if (
      computer?.providerComputerId &&
      computer.status === "ready" &&
      !(await isAutoPausedComputeWorkspace(computer, provider))
    ) {
      const secret = await readRuntimeComputerSecret(computer.id);
      if (!secret) throw new Error("Runtime Computer secret is missing.");
      const target = await provider.agentTarget(computer.providerComputerId, secret);
      await new AgentClient(target).destroyWorkspace({
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        computerId: computer.id,
        userId,
      });
    }
  } catch (error) {
    console.warn(`Workspace ${workspace.id} agent teardown skipped`, error);
  }

  if (provider.topology === "isolated") {
    const computer = await computerForWorkspace(workspace);
    try {
      if (computer?.providerComputerId) {
        await provider.destroyComputer(computer.providerComputerId);
      }
    } catch (error) {
      // A failed provider deletion leaves the persisted placement intact and
      // restores the pre-destroy state so the operator can retry cleanup.
      console.error(`Workspace ${workspace.id} computer destroy failed`, error);
      await restoreAfterFailure(workspace, "destroying", lifecycleError("destroy")).catch(
        (updateError: unknown) => console.error("Could not persist destroy failure", updateError),
      );
      return NextResponse.json({ error: lifecycleError("destroy") }, { status: 502 });
    }
  }

  // Drop the Snapshot index rows: the workspace row is marked destroyed rather
  // than deleted, so the FK cascade never fires — remove them explicitly so a
  // destroyed workspace retains no replay metadata.
  await deleteWorkspaceSnapshots(workspace.id).catch((error: unknown) =>
    console.error(`Could not delete snapshots for ${workspace.id}`, error),
  );

  const completed = await completeTransition({
    id: workspace.id,
    from: "destroying",
    patch: {
      status: "destroyed",
      sandboxId: null,
      volumeName: null,
      worktreePath: null,
      errorMessage: null,
    },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "destroyed" } })
    : lifecycleReconciliationRequired("destroy");
}

async function resumeWorkspace(workspace: Workspace, provider: RuntimeProvider) {
  if (workspace.status !== "suspended" || !workspace.volumeName) {
    return NextResponse.json(
      { error: "Only a suspended workspace with persistent storage can be resumed." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["suspended"], "resuming");
  if (!transitioned) return lifecycleConflict();

  let sandboxId: string;
  try {
    const result = await provider.resumeWorkspace({
      workspaceId: workspace.id,
      volumeName: workspace.volumeName,
      env: {},
    });
    sandboxId = result.sandboxId;
  } catch (error) {
    console.error(`Workspace ${workspace.id} resume failed`, error);
    await restoreAfterFailure(workspace, "resuming", lifecycleError("resume")).catch(
      (updateError: unknown) => console.error("Could not persist resume failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("resume") }, { status: 502 });
  }

  try {
    const completed = await completeTransition({
      id: workspace.id,
      from: "resuming",
      patch: {
        status: "ready",
        sandboxId,
        errorMessage: null,
        touchActive: true,
      },
    });
    if (completed) {
      return NextResponse.json({ workspace: { id: workspace.id, status: "ready" } });
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} resume completion failed`, error);
  }
  return lifecycleReconciliationRequired("resume");
}

async function suspendWorkspace(workspace: Workspace, provider: RuntimeProvider) {
  if (
    (workspace.status !== "ready" && workspace.status !== "idle") ||
    !workspace.sandboxId
  ) {
    return NextResponse.json(
      { error: "Only an active workspace can be suspended." },
      { status: 409 },
    );
  }
  // Interactive Runtime no longer derives lifecycle state from the jobs table:
  // the runtime-agent (tmux + Claude session) is the source of truth for active
  // execution, so suspend/destroy decide on the Runtime Computer's live session.
  // Legacy batch job rows are intentionally ignored — do NOT reintroduce a
  // jobs-table guard (e.g. hasActiveJob) here.
  const transitioned = await startTransition(workspace, ["ready", "idle"], "suspending");
  if (!transitioned) return lifecycleConflict();

  try {
    await provider.suspendWorkspace({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} suspend failed`, error);
    await restoreAfterFailure(workspace, "suspending", lifecycleError("suspend")).catch(
      (updateError: unknown) => console.error("Could not persist suspend failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("suspend") }, { status: 502 });
  }

  try {
    const completed = await completeTransition({
      id: workspace.id,
      from: "suspending",
      patch: { status: "suspended", sandboxId: null, errorMessage: null },
    });
    if (completed) {
      return NextResponse.json({ workspace: { id: workspace.id, status: "suspended" } });
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} suspend completion failed`, error);
  }
  return lifecycleReconciliationRequired("suspend");
}

async function destroyWorkspace(workspace: Workspace, provider: RuntimeProvider) {
  const destroyable: WorkspaceStatus[] = ["ready", "idle", "suspended", "archived", "failed"];
  if (!destroyable.includes(workspace.status)) {
    return NextResponse.json(
      { error: "This workspace cannot be destroyed while another lifecycle action is running." },
      { status: 409 },
    );
  }
  // Legacy batch job rows are intentionally ignored here too — runtime-agent, not
  // the jobs table, owns active-execution state (see suspendWorkspace).
  const transitioned = await startTransition(workspace, destroyable, "destroying");
  if (!transitioned) return lifecycleConflict();

  try {
    await provider.destroyWorkspace({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
      volumeName: workspace.volumeName,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} destroy failed`, error);
    await restoreAfterFailure(workspace, "destroying", lifecycleError("destroy")).catch(
      (updateError: unknown) => console.error("Could not persist destroy failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("destroy") }, { status: 502 });
  }

  try {
    const completed = await completeTransition({
      id: workspace.id,
      from: "destroying",
      patch: {
        status: "destroyed",
        sandboxId: null,
        volumeName: null,
        worktreePath: null,
        errorMessage: null,
      },
    });
    if (completed) {
      return NextResponse.json({ workspace: { id: workspace.id, status: "destroyed" } });
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} destroy completion failed`, error);
  }
  return lifecycleReconciliationRequired("destroy");
}

function lifecycleConflict() {
  return NextResponse.json(
    { error: "This workspace changed in another session. Refresh and try again." },
    { status: 409 },
  );
}

function lifecycleReconciliationRequired(action: LifecycleAction) {
  return NextResponse.json(
    {
      error: `${action[0].toUpperCase()}${action.slice(1)} completed, but Runtime could not save its final state. Refresh before trying another action.`,
    },
    { status: 503 },
  );
}
