import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, getWorkspace, getWorkspacePullRequest, listJobs, listWorkspaces } from "@/lib/db/repositories";
import { reconcileWorkspaceJobs } from "@/lib/runtime/compute.deps";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
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
  // Settle any jobs that finished while this page was closed, then read fresh
  // rows — durability: job status settles whenever the owner views the page,
  // with no live SSE stream required. Best-effort; never blocks the render.
  await reconcileWorkspaceJobs(workspace).catch(() => {});
  const [jobs, pullRequest, workspaces] = await Promise.all([
    listJobs(workspace.id),
    getWorkspacePullRequest(workspace.id),
    listWorkspaces(project.id),
  ]);

  return (
    <AppShell immersive>
      <WorkspaceStudio
        project={project}
        workspace={workspace}
        workspaces={workspaces}
        jobs={jobs}
        pullRequest={pullRequest}
      />
    </AppShell>
  );
}
