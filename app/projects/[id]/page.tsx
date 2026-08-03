import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ExternalLink,
  GitBranch,
  LockKeyhole,
  UnlockKeyhole,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject } from "@/lib/db/repositories";

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

      <Card className="mt-5 max-w-2xl border-dashed">
        <CardContent className="py-2 text-sm">
          <p className="font-medium">Workspaces arrive next</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Runtime will create a persistent workspace from this repository in
            the next milestone.
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
