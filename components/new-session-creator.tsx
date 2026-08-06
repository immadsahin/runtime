"use client";

import { useRouter } from "next/navigation";
import { ChevronDown, GitBranch, LoaderCircle } from "lucide-react";
import { useState, useTransition } from "react";

import { ProjectAvatar } from "@/components/project-avatar";
import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { SessionComposer } from "@/components/session-composer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@/lib/runtime/types";

type CreateResponse = { workspace?: { id: string }; error?: string };

/**
 * The new-session screen: a faded wordmark over a centered composer, with a
 * repository + base-branch selector beneath it. Submitting creates a workspace
 * from the chosen repo and opens it, carrying the first prompt along so the
 * session starts on that instruction.
 */
export function NewSessionCreator({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-2xl">
        <p
          aria-hidden
          className="pointer-events-none mb-6 select-none text-center text-[13vw] font-bold leading-none tracking-tight text-neutral-200 sm:text-[96px]"
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
            <div className="relative">
              {isCreating && (
                <div className="absolute inset-0 z-10 grid place-items-center rounded-[14px] bg-white/60">
                  <LoaderCircle className="text-muted-foreground size-5 animate-spin" />
                </div>
              )}
              <SessionComposer onSend={create} canSend={!isCreating} />
            </div>

            <div className="mt-5 flex items-center justify-center gap-2.5 text-[15px]">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-neutral-700 transition-colors hover:bg-neutral-100"
                  >
                    <ProjectAvatar name={selected?.name ?? "?"} className="size-5" />
                    {selected?.name ?? "Select a repository"}
                    <ChevronDown className="size-4 text-neutral-400" />
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

              <span className="text-neutral-300">/</span>
              <span className="flex items-center gap-1.5 text-neutral-500">
                <GitBranch className="size-4" />
                {selected?.defaultBranch ?? "main"}
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
  );
}
