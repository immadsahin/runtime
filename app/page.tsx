import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { HomeView } from "@/components/home-view";
import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjects, listWorkspaces } from "@/lib/db/repositories";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

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

  // Workspaces arrive most-recent-first, so the head is the single session to
  // "Continue" in the center column.
  const recent = workspaces[0];
  const lastSession = recent
    ? {
        id: recent.id,
        title: recent.branch,
        project: projectsById.get(recent.projectId)?.name ?? "repository",
      }
    : null;

  // The sidebar surfaces only projects with a live workspace, so the list
  // reflects what you're actually working on. Every repository is still
  // reachable through the create picker.
  const activeProjectIds = new Set(workspaces.map((w) => w.projectId));
  const activeProjects = projects.filter((p) => activeProjectIds.has(p.id));

  return (
    <AppShell immersive>
      <HomeView
        ownerLogin={owner.githubLogin}
        ownerAvatarUrl={owner.avatarUrl}
        activeProjects={activeProjects}
        lastSession={lastSession}
      />
    </AppShell>
  );
}
