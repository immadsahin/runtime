import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getRuntimeComputerByProject,
  getWorkspace,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Deliver a user prompt to a workspace's agent session. This is the jcode-engine
 * prompt path: the browser composer POSTs here (same-origin), and we proxy to
 * the runtime-agent's /message over the control preview URL. The reply streams
 * back to the browser on the Conversation SSE, not in this response.
 *
 * Server-to-server on purpose: the agent lives on a different origin (the
 * Daytona preview host) with no CORS, and the Runtime token secret must stay on
 * the server.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { content?: string } | null;
  const content = body?.content?.trim();
  if (!content) {
    return NextResponse.json({ error: "A non-empty content is required." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!(provider instanceof DaytonaRuntimeProvider)) {
    return NextResponse.json(
      { error: "Messaging requires the Daytona runtime provider." },
      { status: 409 },
    );
  }

  const computer = await getRuntimeComputerByProject(workspace.projectId);
  if (!computer || !computer.daytonaSandboxId || computer.status !== "ready") {
    return NextResponse.json(
      { error: "Runtime Computer is not ready." },
      { status: 409 },
    );
  }

  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) {
    return NextResponse.json({ error: "Runtime Computer secret missing." }, { status: 500 });
  }

  let target;
  try {
    target = await provider.agentTarget(computer.daytonaSandboxId, secret);
  } catch (error) {
    console.error(`Message: agentTarget failed for ${workspace.id}`, error);
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
    await new AgentClient(target).sendMessage(identity, content);
  } catch (error) {
    console.error(`Message: send failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Send failed." },
      { status: 502 },
    );
  }
  return NextResponse.json({ result: "sent" });
}
