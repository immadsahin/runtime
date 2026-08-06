import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getRuntimeComputer,
  getWorkspace,
  readRuntimeComputerSecret,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { SessionUrls } from "@/lib/runtime/agent-protocol";
import {
  AUTO_PAUSE_MESSAGE,
  autoPauseWorkspaceTransition,
  hasActiveComputeWorkspace,
  isAutoPausedComputeWorkspace,
} from "@/lib/runtime/compute-lifecycle";
import {
  isComputeRuntimeProvider,
  providerErrorResponse,
  resolveProvider,
} from "@/lib/runtime/resolve";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Session attach endpoint. Mints the short-lived Runtime tokens (5-min TTL) and
 * returns the URLs the browser subscribes to for this Workspace Session.
 *
 * The token secret never leaves the server; only the finished `wss://` URL
 * crosses the wire. Clients re-call this route whenever a stream closes to
 * refresh the URLs — do NOT cache them past a single connection.
 *
 * See docs/architecture/session-contract.md.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
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

  // Computer-backed providers expose the frozen runtime-agent PTY protocol;
  // workspace-per-sandbox providers do not.
  if (!isComputeRuntimeProvider(provider)) {
    return NextResponse.json(
      { error: "Live sessions require a Runtime Computer provider." },
      { status: 409 },
    );
  }
  if (!hasActiveComputeWorkspace(workspace)) {
    return NextResponse.json(
      { error: "Resume this workspace before attaching to its live session." },
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
      { error: "This project has no Runtime Computer. Create a workspace first." },
      { status: 409 },
    );
  }
  if (computer.status !== "ready") {
    return NextResponse.json(
      { error: `Runtime Computer is ${computer.status}; try again shortly.` },
      { status: 409 },
    );
  }
  if (await isAutoPausedComputeWorkspace(computer, provider)) {
    await transitionWorkspace(autoPauseWorkspaceTransition(workspace.id));
    return NextResponse.json(
      { error: AUTO_PAUSE_MESSAGE },
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
    console.error(`Session attach: agentTarget failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: "Could not reach the Runtime Computer. Try again." },
      { status: 503 },
    );
  }

  const identity: WorkspaceIdentity = {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    computerId: computer.id,
    userId: owner.id,
  };
  const agent = new AgentClient(target);

  // Fetch the current WorkspaceSummary alongside the URLs so the browser has
  // it on the first paint without an extra round-trip. If the agent hiccups,
  // omit summary — clients can hit /api/workspaces/[id]/summary directly.
  let summary;
  try {
    summary = await agent.workspaceSummary(identity);
  } catch (error) {
    console.warn(`Session attach: summary fetch failed for ${workspace.id}`, error);
  }

  const body: SessionUrls = {
    ptyUrl: agent.ptyUrl(identity),
    eventsUrl: agent.eventsUrl(identity),
    ...(summary && { summary }),
  };
  return NextResponse.json(SessionUrls.parse(body));
}
