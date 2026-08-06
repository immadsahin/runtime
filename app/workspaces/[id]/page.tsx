import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, getWorkspace, getWorkspacePullRequest, listWorkspaces } from "@/lib/db/repositories";

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
  const [pullRequest, workspaces] = await Promise.all([
    getWorkspacePullRequest(workspace.id),
    listWorkspaces(project.id),
  ]);

  return (
    <AppShell immersive>
      <WorkspaceStudio
        project={project}
        workspace={workspace}
        workspaces={workspaces}
        pullRequest={pullRequest}
        initialPrompt={prompt}
      />
    </AppShell>
  );
}
