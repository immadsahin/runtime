import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { WorkspaceReplay } from "@/components/workspace-replay";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, getWorkspace, listWorkspaceSnapshots } from "@/lib/db/repositories";

export const dynamic = "force-dynamic";

/**
 * Replay view for a workspace's Snapshots — browser + storage only, no Runtime
 * Computer (M4 invariant #2). Reachable from the workspace's lifecycle controls
 * once it's archived.
 */
export default async function WorkspaceReplayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  const project = await getProject(workspace.projectId);
  if (!project) notFound();

  const snapshots = await listWorkspaceSnapshots(workspace.id);

  return (
    <AppShell immersive>
      {/* Definite viewport height so the terminal/conversation panels' h-full /
          flex-1 chain resolves instead of collapsing to content height. */}
      <div className="flex h-dvh min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b px-4 py-2 text-sm">
          <Link className="text-muted-foreground hover:underline" href={`/workspaces/${workspace.id}`}>
            ← {project.fullName}
          </Link>
          <span className="font-medium">Replay · {workspace.branch}</span>
        </div>
        <div className="min-h-0 flex-1">
          <WorkspaceReplay workspaceId={workspace.id} snapshots={snapshots} />
        </div>
      </div>
    </AppShell>
  );
}
