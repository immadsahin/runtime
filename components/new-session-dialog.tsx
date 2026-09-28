"use client";

import { ArrowUp, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ProjectAvatar } from "@/components/project-avatar";
import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { WorkspaceCreating } from "@/components/workspace-creating";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCreateSession } from "@/hooks/use-create-session";
import type { Project } from "@/lib/runtime/types";

/**
 * The new-session flow as a modal (the home page opens this instead of routing
 * to /new). The dialog itself is the composer card — the repository picker sits
 * top-left, the prompt fills the body, and Create submits. Radix unmounts the
 * content on close, so each open remounts the body fresh, reinitialising the
 * selected project to `initialProjectId` (the last project, or a clicked row).
 */
export function NewSessionDialog({
  open,
  onOpenChange,
  projects,
  initialProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  initialProjectId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">New session</DialogTitle>
        <DialogDescription className="sr-only">
          Start a new Claude session on a repository.
        </DialogDescription>
        <NewSessionModalBody projects={projects} initialProjectId={initialProjectId} />
      </DialogContent>
    </Dialog>
  );
}

function NewSessionModalBody({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  initialProjectId?: string;
}) {
  const { setProjectId, selected, isCreating, message, create } = useCreateSession(
    projects,
    initialProjectId,
  );
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (text === "" || isCreating) return;
    create(text);
  };

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-10 text-center">
        <p className="text-sm font-medium">No repositories synchronized</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Pull in the repositories your GitHub token can access to start a session.
        </p>
        <ProjectsSyncButton align="center" />
      </div>
    );
  }

  return (
    <>
      {/* Provisioning takes tens of seconds — show the staged progress FULL PAGE,
          not inside the modal. The dialog card carries a CSS transform, which
          would trap a `fixed`/full-height child inside its box, so portal the
          progress to document.body (an opaque layer above the dialog). The modal
          stays mounted underneath, so a failed create returns to the composer
          with the typed prompt intact. */}
      {isCreating && selected && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-[60] bg-background">
              <WorkspaceCreating
                projectName={selected.fullName}
                branch={selected.defaultBranch}
              />
            </div>,
            document.body,
          )
        : null}

      {/* Header — repository picker, top-left (Conductor-style). */}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3 pr-12">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <ProjectAvatar name={selected?.name ?? "?"} className="size-5" />
              {selected?.name ?? "Select a repository"}
              <ChevronDown className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
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

      {/* Prompt — the composer body. */}
      <textarea
        ref={textareaRef}
        value={value}
        rows={3}
        autoFocus
        placeholder="What do you want to work on?"
        aria-label="Prompt"
        spellCheck={false}
        className="min-h-[128px] w-full resize-none bg-transparent px-4 py-4 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          setValue(event.target.value);
          const el = event.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />

      {/* Footer — Create. */}
      <div className="flex items-center justify-end px-4 pb-4">
        <button
          type="button"
          onClick={submit}
          disabled={isCreating || value.trim() === ""}
          className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Create
          <ArrowUp className="size-3.5" />
        </button>
      </div>

      {message && (
        <p aria-live="polite" className="px-4 pb-4 text-center text-xs text-destructive">
          {message}
        </p>
      )}
    </>
  );
}
