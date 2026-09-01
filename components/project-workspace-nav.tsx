"use client";

import Link from "next/link";
import { GitBranch, Plus } from "lucide-react";

import { ProjectAvatar } from "@/components/project-avatar";
import type { Project, Workspace } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/**
 * Nested project → workspace navigation. Only repos that have at least one
 * workspace appear; each lists its workspaces underneath, most-recent first,
 * with a hover `+` to open a new one in that repo. Repos without a workspace
 * yet are reached through "New session" (the full repo picker).
 */
export function ProjectWorkspaceNav({
  projects,
  workspaces,
  activeWorkspaceId,
}: {
  projects: Project[];
  workspaces: Workspace[];
  activeWorkspaceId?: string;
}) {
  const byProject = new Map<string, Workspace[]>();
  for (const w of workspaces) {
    const list = byProject.get(w.projectId) ?? [];
    list.push(w);
    byProject.set(w.projectId, list);
  }

  const recency = (w?: Workspace) => w?.lastActiveAt ?? w?.createdAt ?? "";
  const groups = projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({
      project: p,
      items: byProject
        .get(p.id)!
        .slice()
        .sort((a, b) => recency(b).localeCompare(recency(a))),
    }))
    .sort((a, b) => recency(b.items[0]).localeCompare(recency(a.items[0])));

  return (
    <nav className="studio-nav" aria-label="Workspaces">
      {groups.map(({ project, items }) => (
        <div key={project.id} className="studio-nav-group">
          <div className="studio-nav-project">
            <ProjectAvatar name={project.name} className="size-4" />
            <span className="studio-nav-project-name" title={project.fullName}>
              {project.name}
            </span>
            <Link
              href={`/new?project=${project.id}`}
              className="studio-nav-add"
              title={`New workspace in ${project.name}`}
              aria-label={`New workspace in ${project.name}`}
            >
              <Plus />
            </Link>
          </div>
          {items.map((w) => (
            <Link
              key={w.id}
              href={`/workspaces/${w.id}`}
              className={cn(
                "studio-nav-item",
                w.id === activeWorkspaceId && "is-active",
              )}
              title={w.branch}
            >
              <GitBranch className="studio-nav-item-icon" />
              <span className="studio-nav-item-label">
                {w.branch.replace(/^runtime\//, "")}
              </span>
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
