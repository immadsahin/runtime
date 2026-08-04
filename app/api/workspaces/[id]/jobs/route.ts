import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createJobRow,
  getWorkspace,
  hasActiveJob,
  updateJob,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import {
  agentCredentialMessage,
  agentJobEnvironment,
  agentName,
  isJobAgent,
} from "@/lib/runtime/agent";
import { ensureLiveWorkspaceSandbox } from "@/lib/runtime/compute.deps";
import type { JobAgent, WorkspaceStatus } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

const MAX_PROMPT = 20_000;
/** A job may start from any state we can (re)attach live compute to. */
const STARTABLE: WorkspaceStatus[] = ["ready", "idle", "suspended"];
type RouteContext = { params: Promise<{ id: string }> };

/** Start one detached coding-agent job in an active workspace. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  let body: { agent?: unknown; prompt?: unknown };
  try {
    body = (await request.json()) as { agent?: unknown; prompt?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Enter a task for a coding agent." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json(
      { error: `Keep the task under ${MAX_PROMPT.toLocaleString()} characters.` },
      { status: 400 },
    );
  }
  // Omission preserves compatibility with clients created before agent choice.
  const agent: JobAgent | null = body.agent === undefined
    ? "claude"
    : isJobAgent(body.agent)
      ? body.agent
      : null;
  if (!agent) {
    return NextResponse.json({ error: "Choose Claude Code or Codex." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  if (!STARTABLE.includes(workspace.status)) {
    return NextResponse.json(
      { error: "The workspace must be ready before a coding agent can run." },
      { status: 409 },
    );
  }

  const env = agentJobEnvironment(agent);
  if (Object.keys(env).length === 0) {
    return NextResponse.json(
      { error: agentCredentialMessage(agent) },
      { status: 422 },
    );
  }

  // Single active job per workspace keeps compute and log reasoning simple.
  if (await hasActiveJob(workspace.id)) {
    return NextResponse.json(
      { error: "A coding-agent job is already running in this workspace." },
      { status: 409 },
    );
  }

  // Guarantee live compute, resuming a suspended/expired workspace on demand.
  const compute = await ensureLiveWorkspaceSandbox(workspace);
  if (!compute.ok) {
    return NextResponse.json({ error: compute.message }, { status: compute.status });
  }
  const { provider, sandboxId } = compute;

  const job = await createJobRow({
    ownerId: owner.id,
    workspaceId: workspace.id,
    agent,
    prompt,
  });

  try {
    const result = await provider.executeJob({
      workspaceId: workspace.id,
      sandboxId,
      jobId: job.id,
      agent,
      prompt,
      env,
    });
    await updateJob(job.id, {
      status: "running",
      logPath: result.logPath,
      resultPath: result.resultPath,
      executionHandle: result.executionHandle ?? null,
      startedAt: new Date().toISOString(),
    });
    return NextResponse.json({ job: { id: job.id, status: "running" } }, { status: 201 });
  } catch (error) {
    console.error(`Job ${job.id} could not be started`, error);
    await updateJob(job.id, {
      status: "failed",
      exitCode: null,
      finishedAt: new Date().toISOString(),
    }).catch((updateError: unknown) =>
      console.error(`Job ${job.id} failure state could not be saved`, updateError),
    );
    return NextResponse.json(
      { error: `Could not start ${agentName(agent)}. Check Runtime setup and try again.` },
      { status: 502 },
    );
  }
}
