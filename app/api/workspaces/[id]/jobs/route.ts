import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createJobRow,
  getWorkspace,
  hasActiveJob,
  updateJob,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { ensureLiveWorkspaceSandbox } from "@/lib/runtime/compute.deps";
import type { WorkspaceStatus } from "@/lib/runtime/types";
import { claudeJobEnvironment } from "@/lib/runtime/workspace-environment";

export const dynamic = "force-dynamic";

const MAX_PROMPT = 20_000;
/** A job may start from any state we can (re)attach live compute to. */
const STARTABLE: WorkspaceStatus[] = ["ready", "idle", "suspended"];
type RouteContext = { params: Promise<{ id: string }> };

/** Start one detached Claude Code job in an active workspace. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  let body: { prompt?: unknown };
  try {
    body = (await request.json()) as { prompt?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Enter a task for Claude Code." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json(
      { error: `Keep the task under ${MAX_PROMPT.toLocaleString()} characters.` },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  if (!STARTABLE.includes(workspace.status)) {
    return NextResponse.json(
      { error: "The workspace must be ready before Claude Code can run." },
      { status: 409 },
    );
  }

  const env = claudeJobEnvironment();
  if (Object.keys(env).length === 0) {
    return NextResponse.json(
      { error: "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to run Claude Code." },
      { status: 422 },
    );
  }

  // Single active job per workspace keeps compute and log reasoning simple.
  if (await hasActiveJob(workspace.id)) {
    return NextResponse.json(
      { error: "A Claude job is already running in this workspace." },
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
    prompt,
  });

  try {
    const result = await provider.executeJob({
      workspaceId: workspace.id,
      sandboxId,
      jobId: job.id,
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
      { error: "Could not start Claude Code. Check Runtime setup and try again." },
      { status: 502 },
    );
  }
}
