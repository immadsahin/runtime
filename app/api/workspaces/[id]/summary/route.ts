import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getRuntimeComputer,
  getWorkspace,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import {
  isComputeRuntimeProvider,
  providerErrorResponse,
  resolveProvider,
} from "@/lib/runtime/resolve";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Workspace Summary — the canonical, cross-milestone summary Mission Engine
 * (and future consumers) poll for. Live event-driven fields (state, timestamps,
 * tokenUsage, lastAssistantMessage) come from the agent's in-memory collector;
 * git-derived fields (changedFiles, filesTouched, commitCount) are shelled out
 * per request. See `docs/architecture/session-contract.md` +
 * `docs/architecture/m4-plan.md` for the frozen shape.
 *
 * The initial browser attach receives the Summary inline via
 * POST /api/workspaces/[id]/session; this route is the polling surface.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!isComputeRuntimeProvider(provider)) {
    return NextResponse.json(
      { error: "Workspace summaries require a Runtime Computer provider." },
      { status: 409 },
    );
  }

  const computer = workspace.computerId
    ? await getRuntimeComputer(workspace.computerId)
    : null;
  if (
    !computer ||
    computer.projectId !== workspace.projectId ||
    computer.provider !== workspace.provider ||
    !computer.providerComputerId
  ) {
    return NextResponse.json(
      { error: "This project has no Runtime Computer." },
      { status: 409 },
    );
  }

  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) {
    return NextResponse.json({ error: "Runtime Computer secret missing." }, { status: 500 });
  }

  let target;
  try {
    target = await provider.agentTarget(computer.providerComputerId, secret);
  } catch (error) {
    console.error(`Summary: agentTarget failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: "Could not reach the Runtime Computer." },
      { status: 503 },
    );
  }

  const identity: WorkspaceIdentity = {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    computerId: computer.id,
    userId: owner.id,
  };

  try {
    const summary = await new AgentClient(target).workspaceSummary(identity);
    return NextResponse.json(summary);
  } catch (error) {
    console.error(`Summary: fetch failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: "Could not read the Workspace Summary." },
      { status: 502 },
    );
  }
}
