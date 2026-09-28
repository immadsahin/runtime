"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { Project } from "@/lib/runtime/types";

type CreateResponse = { workspace?: { id: string }; error?: string };

/**
 * The new-session creation logic, shared by the full-page creator and the home
 * modal so the fetch + navigate lives in one place. Owns the selected project
 * and the in-flight/error state; the caller supplies the layout.
 */
export function useCreateSession(projects: Project[], initialProjectId?: string) {
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

  return { projectId, setProjectId, selected, isCreating, message, create };
}
