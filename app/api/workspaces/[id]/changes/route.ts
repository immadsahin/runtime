import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getRuntimeComputer, getWorkspace } from "@/lib/db/repositories";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { isComputeRuntimeProvider } from "@/lib/runtime/resolve";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Without `?path=`, list the active worktree's changed files. With `?path=`,
 * return a bounded, text-only diff for that one file. The provider validates
 * membership, rejects traversal and Git pathspec magic, and caps the size.
 */
export async function GET(request: Request, context: RouteContext) {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const provider = getRuntimeProvider();
  if (provider.name !== workspace.provider) {
    return NextResponse.json(
      { error: `Configure the ${workspace.provider} provider to read this workspace.` },
      { status: 409 },
    );
  }

  const path = new URL(request.url).searchParams.get("path");

  try {
    if (isComputeRuntimeProvider(provider)) {
      const computer = workspace.computerId
        ? await getRuntimeComputer(workspace.computerId)
        : null;
      if (
        !computer ||
        computer.projectId !== workspace.projectId ||
        computer.provider !== workspace.provider ||
        !computer.providerComputerId ||
        !workspace.worktreePath
      ) {
        return NextResponse.json(
          { error: "The interactive worktree is not available yet." },
          { status: 409 },
        );
      }
      if (path !== null) {
        const diff = await provider.readWorkspaceChangedFileDiff(
          computer.providerComputerId,
          workspace.worktreePath,
          path,
        );
        return NextResponse.json({ diff });
      }
      const files = await provider.listWorkspaceChangedFiles(
        computer.providerComputerId,
        workspace.worktreePath,
      );
      return NextResponse.json({ files });
    }

    if (!workspace.sandboxId) {
      return NextResponse.json(
        { error: "Resume the workspace to view its changes." },
        { status: 409 },
      );
    }
    if (path !== null) {
      const diff = await provider.readChangedFileDiff({
        workspaceId: workspace.id,
        sandboxId: workspace.sandboxId,
        path,
      });
      return NextResponse.json({ diff });
    }
    const files = await provider.listChangedFiles({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
    });
    return NextResponse.json({ files });
  } catch (error) {
    console.error(`Workspace ${id} changes could not be read`, error);
    const message = error instanceof Error ? error.message : "";
    if (/not part of|Invalid changed file path/i.test(message)) {
      return NextResponse.json(
        { error: "That file is not part of this workspace's changes." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Could not read workspace changes. Check Runtime setup and try again." },
      { status: 500 },
    );
  }
}
