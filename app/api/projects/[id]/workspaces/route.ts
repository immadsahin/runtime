import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspaceRow,
  getProject,
  updateWorkspace,
} from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import { isSameOriginRequest } from "@/lib/http/guards";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { runtimeSessionEnvironment } from "@/lib/runtime/ensure-runtime-computer";
import { ensureProjectRuntimeComputer } from "@/lib/runtime/runtime-computer-service";
import type { ProvisionPhase } from "@/lib/runtime/types";
import { workspaceCloneEnvironment } from "@/lib/runtime/workspace-environment";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function isValidBranchName(branch: string): boolean {
  return (
    branch.length >= 1 &&
    branch.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

function generatedBranch(): string {
  return `runtime/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function safeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return "A live workspace already uses that branch for this project.";
  }
  return "Could not create the workspace. Check Runtime setup and try again.";
}

/** Create one local worktree from a Runtime project. */
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

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if (project.private && !optionalEnv("GITHUB_PAT")) {
    return NextResponse.json(
      {
        error:
          "GITHUB_PAT with Contents read access is required to clone a private repository.",
      },
      { status: 422 },
    );
  }

  let body: { branch?: unknown };
  try {
    body = (await request.json()) as { branch?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const requestedBranch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (requestedBranch && !isValidBranchName(requestedBranch)) {
    return NextResponse.json(
      { error: "Use a valid Git branch name (letters, numbers, ., _, /, and -)." },
      { status: 400 },
    );
  }

  let provider: ReturnType<typeof getRuntimeProvider>;
  try {
    provider = getRuntimeProvider();
  } catch (error) {
    console.error("Runtime provider is unavailable", error);
    return NextResponse.json(
      { error: "The configured Runtime provider is not available." },
      { status: 503 },
    );
  }

  let workspace;
  try {
    workspace = await createWorkspaceRow({
      ownerId: owner.id,
      projectId: project.id,
      branch: requestedBranch || generatedBranch(),
      baseBranch: project.defaultBranch,
      provider: provider.name,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("A live") ? 409 : 500 },
    );
  }

  const setPhase = async (phase: ProvisionPhase) => {
    await updateWorkspace(workspace.id, {
      status: phase === "claude_ready" ? "ready" : "provisioning",
      phase,
      touchActive: phase === "claude_ready",
    });
  };

  try {
    if (provider instanceof DaytonaRuntimeProvider) {
      const githubToken = optionalEnv("GITHUB_PAT");
      const ensured = await ensureProjectRuntimeComputer(provider, {
        projectId: project.id,
        repoFullName: project.fullName,
        githubToken,
        sessionEnv: runtimeSessionEnvironment(),
      });
      const computer = ensured.computer;
      if (!computer.daytonaSandboxId) {
        throw new Error("Ready Runtime Computer has no Daytona sandbox id.");
      }

      // Initial provisioning clones the mirror. Every later workspace refreshes
      // it before the agent branches from the project's default branch.
      if (!ensured.provisioned) {
        await provider.fetchMirror(computer.daytonaSandboxId, githubToken);
      }

      const target = await provider.agentTarget(
        computer.daytonaSandboxId,
        ensured.agentSecret,
      );
      const identity: WorkspaceIdentity = {
        workspaceId: workspace.id,
        projectId: project.id,
        computerId: computer.id,
        userId: owner.id,
      };
      const agent = new AgentClient(target);
      const created = await agent.createWorkspace(
        {
          workspaceId: workspace.id,
          repoFullName: project.fullName,
          baseBranch: project.defaultBranch,
          branch: workspace.branch,
        },
        identity,
      );
      await agent.startWorkspace(identity);

      await updateWorkspace(workspace.id, {
        status: "ready",
        phase: "claude_ready",
        computerId: computer.id,
        tmuxSession: `ws-${workspace.id}`,
        agentWorkspaceId: workspace.id,
        worktreePath: created.worktree,
        errorMessage: null,
        touchActive: true,
      });
      return NextResponse.json({ workspace: { id: workspace.id } }, { status: 201 });
    }

    const result = await provider.createWorkspace({
      workspaceId: workspace.id,
      repoFullName: project.fullName,
      baseBranch: project.defaultBranch,
      branch: workspace.branch,
      env: workspaceCloneEnvironment(),
      onPhase: setPhase,
    });

    await updateWorkspace(workspace.id, {
      status: "ready",
      phase: "claude_ready",
      sandboxId: result.sandboxId,
      volumeName: result.volumeName,
      worktreePath: result.worktreePath,
      errorMessage: result.warnings.length
        ? "Dependency installation completed with warnings."
        : null,
      touchActive: true,
    });
    return NextResponse.json({ workspace: { id: workspace.id } }, { status: 201 });
  } catch (error) {
    console.error(`Workspace ${workspace.id} provisioning failed`, error);
    try {
      await updateWorkspace(workspace.id, {
        status: "failed",
        errorMessage: "Provisioning failed. Check Runtime setup and try again.",
      });
    } catch (updateError) {
      console.error(`Workspace ${workspace.id} failure state could not be saved`, updateError);
    }
    return NextResponse.json(
      { error: "Could not create the workspace. Check Runtime setup and try again." },
      { status: 500 },
    );
  }
}
