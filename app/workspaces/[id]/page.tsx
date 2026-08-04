import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2, CircleDashed, FolderGit2, GitBranch, HardDrive, TriangleAlert } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkspaceChanges } from "@/components/workspace-changes";
import { WorkspaceJobPanel } from "@/components/workspace-job-panel";
import { WorkspaceLifecycleControls } from "@/components/workspace-lifecycle-controls";
import { WorkspacePublishPanel } from "@/components/workspace-publish-panel";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, getWorkspace, getWorkspacePullRequest, listJobs } from "@/lib/db/repositories";
import { reconcileWorkspaceJobs } from "@/lib/runtime/compute.deps";
import type { ProvisionPhase } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

const phases: Array<{ id: ProvisionPhase; label: string }> = [
  { id: "allocate", label: "Allocate workspace storage" },
  { id: "clone", label: "Clone repository" },
  { id: "worktree", label: "Create isolated worktree" },
  { id: "secrets", label: "Inject runtime secrets" },
  { id: "install", label: "Install repository dependencies" },
  { id: "health_check", label: "Verify repository state" },
  { id: "claude_ready", label: "Ready for Claude Code" },
];

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
  const [jobs, pullRequest] = await Promise.all([
    listJobs(workspace.id),
    getWorkspacePullRequest(workspace.id),
  ]);
  const workspaceActive = workspace.status === "ready" || workspace.status === "idle";

  const phaseIndex = workspace.phase ? phases.findIndex((phase) => phase.id === workspace.phase) : -1;

  return (
    <AppShell active="/workspaces">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Link href="/workspaces" className="text-muted-foreground hover:text-foreground text-sm transition-colors">
            Workspaces
          </Link>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{workspace.branch}</h1>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <FolderGit2 className="size-4" />
            <Link href={`/projects/${project.id}`} className="hover:text-foreground hover:underline">
              {project.fullName}
            </Link>
          </p>
        </div>
        <Badge variant={workspace.status === "ready" ? "default" : "outline"} className="font-mono capitalize">
          {workspace.status}
        </Badge>
      </div>

      {workspace.errorMessage && (
        <div className="border-warning/30 bg-warning/10 mt-6 flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" />
          <p>{workspace.errorMessage}</p>
        </div>
      )}

      <div className="mt-8 grid max-w-4xl gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Provisioning</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {phases.map((phase, index) => {
              const complete = workspace.status === "ready" || index <= phaseIndex;
              const current = workspace.status !== "ready" && index === phaseIndex;
              return (
                <div className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm" key={phase.id}>
                  {complete ? (
                    <CheckCircle2 className="text-success size-4" />
                  ) : (
                    <CircleDashed className={current ? "text-warning size-4 animate-spin" : "text-muted-foreground size-4"} />
                  )}
                  <span className={complete ? "" : "text-muted-foreground"}>{phase.label}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
          <CardHeader>
            <CardTitle className="text-base">Workspace</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <Detail label="Provider" value={workspace.provider} icon={<HardDrive className="size-3.5" />} />
            <Detail label="Base branch" value={workspace.baseBranch} icon={<GitBranch className="size-3.5" />} />
            <Detail label="Worktree" value={workspace.worktreePath || "Provisioning"} mono />
          </CardContent>
        </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compute controls</CardTitle>
            </CardHeader>
            <CardContent>
              <WorkspaceLifecycleControls
                status={workspace.status}
                workspaceId={workspace.id}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-5 grid max-w-4xl gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Claude Code</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkspaceJobPanel
              canRun={workspaceActive}
              jobs={jobs}
              workspaceId={workspace.id}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Publish</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkspacePublishPanel
              active={workspaceActive}
              baseBranch={workspace.baseBranch}
              branch={workspace.branch}
              pullRequest={pullRequest}
              workspaceId={workspace.id}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5 max-w-4xl">
        <CardHeader>
          <CardTitle className="text-base">Changes</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkspaceChanges active={workspaceActive} workspaceId={workspace.id} />
        </CardContent>
      </Card>
    </AppShell>
  );
}

function Detail({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={`flex items-center gap-1.5 break-all text-sm ${mono ? "font-mono text-xs" : "capitalize"}`}>
        {icon}
        {value}
      </p>
    </div>
  );
}
