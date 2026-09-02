import type { Project, Workspace } from "@/lib/runtime/types";

/** The only project fields the nav renders — lets us synthesize a placeholder. */
export type NavProject = Pick<Project, "id" | "name" | "fullName">;

export type NavGroup = { project: NavProject; items: Workspace[] };

/** Stand-in group header for a workspace whose project isn't in the list. */
export function fallbackProject(id: string): NavProject {
  return { id, name: "Repository", fullName: "Repository" };
}

const recency = (w?: Workspace) => w?.lastActiveAt ?? w?.createdAt ?? "";

/**
 * Group workspaces under their project for the studio nav, each group's items
 * most-recent-first and groups ordered by their most-recent workspace.
 *
 * Driven off the workspaces, not the project list: a workspace under a hidden
 * (or otherwise unlisted) project is still openable, so it must never vanish
 * from the nav. Its group falls back to a placeholder header instead.
 */
export function buildNavGroups(
  projects: NavProject[],
  workspaces: Workspace[],
): NavGroup[] {
  const byProject = new Map<string, Workspace[]>();
  for (const w of workspaces) {
    const list = byProject.get(w.projectId) ?? [];
    list.push(w);
    byProject.set(w.projectId, list);
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return [...byProject.entries()]
    .map(([projectId, items]) => ({
      project: projectById.get(projectId) ?? fallbackProject(projectId),
      items: items.slice().sort((a, b) => recency(b).localeCompare(recency(a))),
    }))
    .sort((a, b) => recency(b.items[0]).localeCompare(recency(a.items[0])));
}
