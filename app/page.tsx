import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CircleDashed,
  FolderGit2,
  GitBranch,
  LockKeyhole,
  UnlockKeyhole,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjects } from "@/lib/db/repositories";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

const milestones = [
  { id: "M0", label: "App skeleton, Preview + setup scripts", done: true },
  { id: "M1", label: "Supabase schema: projects, workspaces, jobs", done: true },
  { id: "M2", label: "GitHub sign-in and repository sync", done: true },
  { id: "M3", label: "Local workspaces: clone + isolated worktree", done: true },
  { id: "M4", label: "Modal provider: durable cloud workspace", done: true },
  { id: "M5", label: "Resume, suspend, destroy", done: true },
  { id: "M6", label: "Run Claude Code as a detached job" },
  { id: "M7", label: "Stream terminal logs" },
  { id: "M8", label: "Review changed files and diffs" },
  { id: "M9", label: "Create pull requests" },
  { id: "M10", label: "Linear issues attached to projects" },
];

export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  if (!(await getOwnerSafe())) redirect("/signin");

  let projects: Project[] | null = null;
  try {
    projects = await listProjects();
  } catch (error) {
    // Setup owns database diagnostics. The projects screen should remain
    // usable enough to direct the owner there without exposing server details.
    console.error("Could not load projects", error);
  }

  return (
    <AppShell active="/">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Repositories accessible to your GitHub token. Synchronize once to
            make a repository available for a Runtime workspace.
          </p>
        </div>
        <ProjectsSyncButton />
      </div>

      {projects === null ? (
        <Card className="mt-8 border-destructive/30">
          <CardContent className="py-2 text-sm">
            <p className="font-medium">Projects are not available yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Finish the Supabase setup and apply the migration before
              synchronizing repositories.
            </p>
          </CardContent>
        </Card>
      ) : projects.length === 0 ? (
        <Card className="mt-8 border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <FolderGit2 className="text-muted-foreground size-7" />
            <h2 className="mt-4 font-medium">No repositories synchronized</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Add a GitHub PAT with repository access in Setup, then synchronize
              to bring your repositories into Runtime.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <Link
              className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={`/projects/${project.id}`}
              key={project.id}
            >
              <Card className="h-full transition-colors group-hover:bg-accent/40">
                <CardHeader className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="font-mono text-sm">
                      {project.fullName}
                    </CardTitle>
                    <Badge variant="outline" className="gap-1.5 font-normal">
                      {project.private ? (
                        <LockKeyhole className="size-3" />
                      ) : (
                        <UnlockKeyhole className="size-3" />
                      )}
                      {project.private ? "Private" : "Public"}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground line-clamp-2 min-h-10 text-sm">
                    {project.description ?? "No repository description provided."}
                  </p>
                </CardHeader>
                <CardContent className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <GitBranch className="size-3.5" />
                    {project.defaultBranch}
                  </span>
                  {project.language && <span>{project.language}</span>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card className="mt-10">
        <CardHeader>
          <CardTitle className="text-base">Build progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {milestones.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
            >
              {m.done ? (
                <Badge className="bg-success/15 text-success border-success/30 font-mono text-[11px]">
                  done
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-muted-foreground font-mono text-[11px]"
                >
                  <CircleDashed className="mr-1 size-3" />
                  todo
                </Badge>
              )}
              <span className="text-muted-foreground font-mono text-xs">
                {m.id}
              </span>
              <span className={m.done ? "" : "text-muted-foreground"}>
                {m.label}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </AppShell>
  );
}
