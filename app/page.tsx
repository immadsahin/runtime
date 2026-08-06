import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { HomeView, type SessionGroup } from "@/components/home-view";
import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjects, listWorkspaces } from "@/lib/db/repositories";
import type { Project, Workspace } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

/** "Today" / "Yesterday" / "3 days ago" / "Aug 5" for a session's activity. */
function groupLabel(iso: string, now: Date): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Group already-sorted (most-recent-first) workspaces into ordered buckets. */
function groupSessions(
  workspaces: Workspace[],
  projects: Map<string, Project>,
  now: Date,
): SessionGroup[] {
  const groups: SessionGroup[] = [];
  for (const workspace of workspaces) {
    const label = groupLabel(
      workspace.lastActiveAt ?? workspace.createdAt,
      now,
    );
    let group = groups.find((g) => g.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push({
      id: workspace.id,
      title: workspace.branch,
      project: projects.get(workspace.projectId)?.name ?? "repository",
    });
  }
  return groups;
}

export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  if (!(await getOwnerSafe())) redirect("/signin");

  const workspaces = await listWorkspaces();

  // Repositories feed both the Projects rail and the create picker. A failed
  // load must not block the create flow.
  let projects: Project[] = [];
  try {
    projects = await listProjects();
  } catch (error) {
    console.error("Could not load repositories", error);
  }

  // No workspaces yet: open straight into the new-session screen.
  if (workspaces.length === 0) {
    return (
      <AppShell immersive>
        <NewSessionCreator projects={projects} />
      </AppShell>
    );
  }

  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const groups = groupSessions(workspaces, projectsById, new Date());

  // The rail surfaces only projects with a live workspace, so the list reflects
  // what you're actually working on. Every repository is still reachable through
  // the create picker.
  const activeProjectIds = new Set(workspaces.map((w) => w.projectId));
  const activeProjects = projects.filter((p) => activeProjectIds.has(p.id));

  return (
    <AppShell immersive>
      <HomeView activeProjects={activeProjects} groups={groups} />
    </AppShell>
  );
}
