import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ExternalLink,
  GitBranch,
  LockKeyhole,
  UnlockKeyhole,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, listWorkspaces } from "@/lib/db/repositories";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const workspaces = await listWorkspaces(project.id);

  return (
    <AppShell active="/">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            Projects
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.fullName}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {project.description ?? "No repository description provided."}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={project.htmlUrl} rel="noreferrer" target="_blank">
            View on GitHub <ExternalLink />
          </a>
        </Button>
      </div>

      <Card className="mt-8 max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Repository</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-3">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Default branch</p>
            <p className="flex items-center gap-1.5 font-mono text-sm">
              <GitBranch className="size-3.5" />
              {project.defaultBranch}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Visibility</p>
            <Badge variant="outline" className="gap-1.5 font-normal">
              {project.private ? (
                <LockKeyhole className="size-3" />
              ) : (
                <UnlockKeyhole className="size-3" />
              )}
              {project.private ? "Private" : "Public"}
            </Badge>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Primary language</p>
            <p className="text-sm">{project.language ?? "Not detected"}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-5 max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">New workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateWorkspaceForm
            projectId={project.id}
            defaultBranch={project.defaultBranch}
          />
        </CardContent>
      </Card>

      <section className="mt-8 max-w-2xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Workspaces</h2>
          <span className="text-muted-foreground text-xs">
            {workspaces.length === 1
              ? "1 active workspace"
              : `${workspaces.length} active workspaces`}
          </span>
        </div>
        {workspaces.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-2 text-sm">
              <p className="font-medium">No workspaces yet</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Create one to clone this repository into an isolated local
                worktree.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {workspaces.map((workspace) => (
              <Link
                className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={`/workspaces/${workspace.id}`}
                key={workspace.id}
              >
                <Card className="transition-colors hover:bg-accent/40">
                  <CardContent className="flex items-center justify-between gap-4 py-2">
                    <div>
                      <p className="font-mono text-sm">{workspace.branch}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {workspace.phase ? `Phase: ${workspace.phase.replaceAll("_", " ")}` : "Waiting to start"}
                      </p>
                    </div>
                    <WorkspaceStatusBadge status={workspace.status} />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}

function WorkspaceStatusBadge({ status }: { status: string }) {
  const variant = status === "ready" ? "default" : "outline";
  return (
    <Badge variant={variant} className="font-mono text-[11px] capitalize">
      {status}
    </Badge>
  );
}
