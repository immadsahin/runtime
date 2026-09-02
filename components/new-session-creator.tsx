"use client";

import { useRouter } from "next/navigation";
import { Box, ChevronDown, GitBranch } from "lucide-react";
import { useState, useTransition } from "react";

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
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type CreateResponse = { workspace?: { id: string }; error?: string };

/**
 * The isolated Daytona sandbox each workspace runs in — shown on creation so
 * it's clear the project executes in a box, not locally. Fixed spec for now
 * (the default Daytona image); becomes a size picker when we support sizing.
 */
const SANDBOX_TIER = "Sandbox";
const SANDBOX_SPEC = "1 vCPU · 1 GiB · 3 GiB disk";

/**
 * The new-session screen: a faded wordmark over a centered composer, with a
 * repository + base-branch selector beneath it. Submitting creates a workspace
 * from the chosen repo and opens it, carrying the first prompt along so the
 * session starts on that instruction.
 */
export function NewSessionCreator({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  initialProjectId?: string;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(
    initialProjectId && projects.some((p) => p.id === initialProjectId)
      ? initialProjectId
      : (projects[0]?.id ?? ""),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const selected = projects.find((project) => project.id === projectId);

  function create(prompt: string) {
    if (!selected) return;
    startCreating(async () => {
      setMessage(null);
      let response: Response;
      try {
        response = await fetch(`/api/projects/${selected.id}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch: "" }),
        });
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
        return;
      }
      const result = (await response.json().catch(() => ({}))) as CreateResponse;
      if (!response.ok || !result.workspace) {
        setMessage(result.error ?? "Could not start the session. Please try again.");
        return;
      }
      const query = prompt.trim()
        ? `?prompt=${encodeURIComponent(prompt.trim())}`
        : "";
      router.push(`/workspaces/${result.workspace.id}${query}`);
      router.refresh();
    });
  }

  // Provisioning takes tens of seconds; show a staged progress screen instead
  // of freezing the composer behind a spinner. It's an overlay — the form stays
  // mounted (hidden) underneath so a failed create returns the user to a
  // composer that still holds the prompt they just typed.
  return (
    <>
      {isCreating && selected && (
        <WorkspaceCreating
          projectName={selected.fullName}
          branch={selected.defaultBranch}
        />
      )}
      <div
        className={cn(
          "flex min-h-screen flex-col items-center justify-center px-6",
          isCreating && selected && "hidden",
        )}
      >
        <div className="w-full max-w-2xl">
        <p
          aria-hidden
          className="pointer-events-none mb-6 select-none text-center text-[13vw] font-bold leading-none tracking-tight text-neutral-800 sm:text-[96px]"
        >
          runtime
        </p>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed py-12 text-center">
            <p className="text-sm font-medium">No repositories synchronized</p>
            <p className="text-muted-foreground max-w-xs text-xs">
              Pull in the repositories your GitHub token can access to start a
              session.
            </p>
            <ProjectsSyncButton align="center" />
          </div>
        ) : (
          <>
            <SessionComposer onSend={create} canSend={!isCreating} />

            <div className="mt-5 flex items-center justify-center gap-2.5 text-[15px]">
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

              <span className="text-muted-foreground">/</span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <GitBranch className="size-4" />
                {selected?.defaultBranch ?? "main"}
              </span>

              <span className="text-muted-foreground">·</span>
              <span
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px] text-foreground"
                title="This workspace runs in an isolated Daytona sandbox — the project is cloned into a cloud box, not your machine."
              >
                <Box className="size-4 text-muted-foreground" />
                <span className="font-medium">{SANDBOX_TIER}</span>
                <span className="text-muted-foreground">{SANDBOX_SPEC}</span>
              </span>
            </div>

            {message && (
              <p aria-live="polite" className="text-destructive mt-4 text-center text-xs">
                {message}
              </p>
            )}
          </>
        )}
        </div>
      </div>
    </>
  );
}
