import Link from "next/link";
import { redirect } from "next/navigation";
import { FolderGit2, HardDrive } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, listWorkspaces } from "@/lib/db/repositories";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  if (!(await getOwnerSafe())) redirect("/signin?next=/workspaces");

  const workspaces = await listWorkspaces();
  const projectNames = new Map(
    await Promise.all(
      workspaces.map(async (workspace) => [workspace.projectId, await getProject(workspace.projectId)] as const),
    ),
  );

  return (
    <AppShell active="/workspaces">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Isolated repository worktrees running through your local Runtime provider.
        </p>
      </div>

      {workspaces.length === 0 ? (
        <Card className="mt-8 border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <HardDrive className="text-muted-foreground size-7" />
            <h2 className="mt-4 font-medium">No workspaces yet</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Open a synchronized project to create its first isolated worktree.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {workspaces.map((workspace) => {
            const project = projectNames.get(workspace.projectId);
            return (
              <Link
                className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={`/workspaces/${workspace.id}`}
                key={workspace.id}
              >
                <Card className="h-full transition-colors group-hover:bg-accent/40">
                  <CardHeader className="gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="font-mono text-sm">{workspace.branch}</CardTitle>
                      <Badge variant={workspace.status === "ready" ? "default" : "outline"} className="font-mono text-[11px] capitalize">
                        {workspace.status}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <FolderGit2 className="size-3.5" />
                      {project?.fullName ?? "Repository unavailable"}
                    </p>
                  </CardHeader>
                  <CardContent className="text-muted-foreground text-xs">
                    {workspace.phase ? `Provisioning: ${workspace.phase.replaceAll("_", " ")}` : "Waiting to provision"}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
