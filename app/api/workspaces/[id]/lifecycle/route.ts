import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getWorkspace,
  hasActiveJob,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import type { RuntimeProvider, Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { workspaceRuntimeEnvironment } from "@/lib/runtime/workspace-environment";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type LifecycleAction = "resume" | "suspend" | "destroy";

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const baseUrl = optionalEnv("RUNTIME_BASE_URL");
  if (!baseUrl) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function actionFor(body: unknown): LifecycleAction | null {
  if (!body || typeof body !== "object" || !("action" in body)) return null;
  const action = body.action;
  return action === "resume" || action === "suspend" || action === "destroy"
    ? action
    : null;
}

function lifecycleProvider(workspace: Workspace): RuntimeProvider | null {
  const provider = getRuntimeProvider();
  return provider.name === workspace.provider ? provider : null;
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

  if (!(await getOwner())) {
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
    return NextResponse.json({ error: "Use resume, suspend, or destroy." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  let provider: RuntimeProvider | null;
  try {
    provider = lifecycleProvider(workspace);
  } catch (error) {
    console.error(`Workspace ${id} provider is unavailable`, error);
    return NextResponse.json(
      { error: "The configured Runtime provider is not available." },
      { status: 503 },
    );
  }
  if (!provider) {
    return NextResponse.json(
      { error: `Configure the ${workspace.provider} provider before managing this workspace.` },
      { status: 409 },
    );
  }

  if (action === "resume") return resumeWorkspace(workspace, provider);
  if (action === "suspend") return suspendWorkspace(workspace, provider);
  return destroyWorkspace(workspace, provider);
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
      env: workspaceRuntimeEnvironment(),
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
  if (await hasActiveJob(workspace.id)) return activeJobConflict("suspended");
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
  const destroyable: WorkspaceStatus[] = ["ready", "idle", "suspended", "failed"];
  if (!destroyable.includes(workspace.status)) {
    return NextResponse.json(
      { error: "This workspace cannot be destroyed while another lifecycle action is running." },
      { status: 409 },
    );
  }
  if (await hasActiveJob(workspace.id)) return activeJobConflict("destroyed");
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

function activeJobConflict(nextState: "suspended" | "destroyed") {
  return NextResponse.json(
    { error: `Finish or cancel the active Claude job before this workspace can be ${nextState}.` },
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
