import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspacePullRequest,
  getProject,
  getWorkspace,
  getWorkspacePullRequest,
} from "@/lib/db/repositories";
import { optionalEnv, requireEnv } from "@/lib/env";
import {
  findOrCreatePullRequest,
  GitHubSyncError,
  verifyTokenOwner,
} from "@/lib/github/client";
import { isSameOriginRequest } from "@/lib/http/guards";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";

export const dynamic = "force-dynamic";

const MAX_TITLE = 256;
const MAX_BODY = 8_000;
type RouteContext = { params: Promise<{ id: string }> };

/** Commit the worktree as the owner, push its branch, and open one PR. */
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
  if (
    (workspace.status !== "ready" && workspace.status !== "idle") ||
    !workspace.sandboxId
  ) {
    return NextResponse.json(
      { error: "The workspace must be ready before it can be published." },
      { status: 409 },
    );
  }
  const project = await getProject(workspace.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  let body: { title?: unknown; body?: unknown };
  try {
    body = (await request.json()) as { title?: unknown; body?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const title =
    (typeof body.title === "string" && body.title.trim().slice(0, MAX_TITLE)) ||
    `Runtime: ${workspace.branch}`;
  const prBody = typeof body.body === "string" ? body.body.slice(0, MAX_BODY) : "";

  if (!optionalEnv("GITHUB_PAT")) {
    return NextResponse.json(
      {
        error:
          "GITHUB_PAT with Contents and Pull requests write access is required to publish.",
      },
      { status: 422 },
    );
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;

  // Idempotent: a persisted PR record means this workspace is already published.
  const existing = await getWorkspacePullRequest(workspace.id);
  if (existing) {
    return NextResponse.json({ pullRequest: existing, alreadyPublished: true });
  }

  // Confirm the PAT still belongs to the signed-in owner before using it.
  try {
    await verifyTokenOwner(owner.githubLogin);
  } catch (error) {
    console.error(`Workspace ${id} publish token check failed`, error);
    return NextResponse.json(
      {
        error:
          error instanceof GitHubSyncError
            ? error.message
            : "GitHub could not authorize the configured token.",
      },
      { status: 502 },
    );
  }

  try {
    const changed = await provider.listChangedFiles({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
    });
    if (changed.length > 0) {
      await provider.commitWorkspace({
        workspaceId: workspace.id,
        sandboxId: workspace.sandboxId,
        message: title,
        author: {
          name: owner.githubLogin,
          email: owner.email ?? `${owner.githubLogin}@users.noreply.github.com`,
        },
      });
    }
    await provider.pushWorkspaceBranch({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
      repoFullName: project.fullName,
      branch: workspace.branch,
      githubToken: requireEnv("GITHUB_PAT"),
    });
  } catch (error) {
    console.error(`Workspace ${id} commit/push failed`, error);
    return NextResponse.json(
      { error: "Could not commit and push this workspace. Check Runtime setup and try again." },
      { status: 502 },
    );
  }

  let pr;
  try {
    pr = await findOrCreatePullRequest({
      repoFullName: project.fullName,
      headBranch: workspace.branch,
      baseBranch: workspace.baseBranch,
      title,
      body: prBody,
    });
  } catch (error) {
    console.error(`Workspace ${id} pull request failed`, error);
    return NextResponse.json(
      {
        error:
          error instanceof GitHubSyncError
            ? error.message
            : "Could not open a pull request. Please try again.",
      },
      { status: 502 },
    );
  }

  try {
    const record = await createWorkspacePullRequest({
      ownerId: owner.id,
      workspaceId: workspace.id,
      number: pr.number,
      url: pr.url,
      title,
      baseBranch: workspace.baseBranch,
      headBranch: workspace.branch,
    });
    return NextResponse.json({ pullRequest: record }, { status: 201 });
  } catch (error) {
    // A concurrent publish may have persisted the record first; prefer it.
    const persisted = await getWorkspacePullRequest(workspace.id).catch(() => null);
    if (persisted) {
      return NextResponse.json({ pullRequest: persisted });
    }
    console.error(`Workspace ${id} pull request record could not be saved`, error);
    return NextResponse.json(
      { error: "Pull request opened, but Runtime could not save it. Refresh before publishing again." },
      { status: 500 },
    );
  }
}
