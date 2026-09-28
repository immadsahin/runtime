"use client";

import { ChevronDown } from "lucide-react";

import { ProjectAvatar } from "@/components/project-avatar";
import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { SessionComposer } from "@/components/session-composer";
import { WorkspaceCreating } from "@/components/workspace-creating";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCreateSession } from "@/hooks/use-create-session";
import type { Project } from "@/lib/runtime/types";

/**
 * The reusable new-session form (full-page layout): a composer with a repository
 * selector beneath it. Submitting creates a workspace from the chosen repo and
 * opens it, carrying the first prompt so the session starts on that instruction.
 * The home page opens the same flow in a modal (NewSessionDialog); both share
 * the create logic via useCreateSession.
 */
export function NewSessionForm({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  /** Repo to preselect (the last-used project). Falls back to the first. */
  initialProjectId?: string;
}) {
  const { setProjectId, selected, isCreating, message, create } = useCreateSession(
    projects,
    initialProjectId,
  );

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed py-12 text-center">
        <p className="text-sm font-medium">No repositories synchronized</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          Pull in the repositories your GitHub token can access to start a session.
        </p>
        <ProjectsSyncButton align="center" />
      </div>
    );
  }

  return (
    <>
      {isCreating && selected && (
        <WorkspaceCreating
          projectName={selected.fullName}
          branch={selected.defaultBranch}
        />
      )}

      <SessionComposer onSend={create} canSend={!isCreating} />

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[15px]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-foreground transition-colors hover:bg-accent"
            >
              <ProjectAvatar name={selected?.name ?? "?"} className="size-5" />
              {selected?.name ?? "Select a repository"}
              <ChevronDown className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="max-h-72 w-64 overflow-y-auto">
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => setProjectId(project.id)}
              >
                <ProjectAvatar name={project.name} className="size-5" />
                <span className="truncate">{project.fullName}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {message && (
        <p aria-live="polite" className="text-destructive mt-4 text-center text-xs">
          {message}
        </p>
      )}
    </>
  );
}
