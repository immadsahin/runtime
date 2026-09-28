import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { HomeView } from "@/components/home-view";
import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjects, listWorkspaces } from "@/lib/db/repositories";
import { recency } from "@/lib/nav/workspace-nav-groups";
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

  // The single session to "Continue" in the center column. listWorkspaces sorts
  // by last_active_at with nulls last, so a brand-new (still-provisioning)
  // workspace — whose last_active_at is null — sorts to the tail; rank by
  // `lastActiveAt ?? createdAt` (the studio nav's rule) so the newest wins.
  const recent = workspaces.reduce((a, b) =>
    recency(b).localeCompare(recency(a)) > 0 ? b : a,
  );
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
        projects={projects}
        lastSession={lastSession}
        lastProjectId={recent?.projectId}
      />
    </AppShell>
  );
}
