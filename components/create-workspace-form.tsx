"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type CreateWorkspaceResponse = {
  workspace?: { id: string };
  error?: string;
};

export function CreateWorkspaceForm({
  projectId,
  defaultBranch,
}: {
  projectId: string;
  defaultBranch: string;
}) {
  const router = useRouter();
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  function createWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startCreating(async () => {
      setMessage(null);
      let response: Response;
      try {
        response = await fetch(`/api/projects/${projectId}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch }),
        });
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
        return;
      }

      const result = (await response.json().catch(() => ({}))) as CreateWorkspaceResponse;
      if (!response.ok || !result.workspace) {
        setMessage(result.error ?? "Workspace creation failed. Please try again.");
        return;
      }

      router.push(`/workspaces/${result.workspace.id}`);
      router.refresh();
    });
  }

  return (
    <form className="space-y-3" onSubmit={createWorkspace}>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="workspace-branch">
          Branch name <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <Input
          id="workspace-branch"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="runtime/my-task"
          disabled={isCreating}
          maxLength={128}
          spellCheck={false}
        />
        <p className="text-muted-foreground text-xs">
          Runtime branches from <span className="font-mono">{defaultBranch}</span>. Leave blank to generate a private branch name.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={isCreating} type="submit" size="sm">
          {isCreating ? <LoaderCircle className="animate-spin" /> : <Plus />}
          {isCreating ? "Creating workspace" : "Create workspace"}
        </Button>
        {message && (
          <p aria-live="polite" className="text-destructive text-xs">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
