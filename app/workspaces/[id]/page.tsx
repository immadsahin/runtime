import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { getOwnerSafe } from "@/lib/auth/owner";
import {
  getProject,
  getWorkspace,
  getWorkspacePullRequest,
  listProjects,
  listWorkspaces,
} from "@/lib/db/repositories";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prompt?: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const { prompt } = await searchParams;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  const project = await getProject(workspace.projectId);
  if (!project) notFound();
  // The sidebar list is auxiliary: a failed repositories/workspaces load must
  // not take down the workspace itself, which renders fine without the rail.
  const [pullRequest, allWorkspaces, listedProjects] = await Promise.all([
    getWorkspacePullRequest(workspace.id),
    listWorkspaces().catch((error) => {
      console.error("Could not load workspaces", error);
      return [];
    }),
    listProjects().catch((error) => {
      console.error("Could not load repositories", error);
      return [];
    }),
  ]);
  // `listProjects` hides hidden repos, but this workspace's project is openable
  // regardless — merge it in so the current workspace never drops from the nav.
  const allProjects = listedProjects.some((p) => p.id === project.id)
    ? listedProjects
    : [project, ...listedProjects];

  return (
    <AppShell immersive>
      <WorkspaceStudio
        workspace={workspace}
        allProjects={allProjects}
        allWorkspaces={allWorkspaces}
        pullRequest={pullRequest}
        initialPrompt={prompt}
      />
    </AppShell>
  );
}
