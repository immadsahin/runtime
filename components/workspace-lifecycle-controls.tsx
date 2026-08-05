"use client";

import { Archive, History, LoaderCircle, Pause, Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { WorkspaceStatus } from "@/lib/runtime/types";

type LifecycleAction = "resume" | "suspend" | "destroy" | "archive";

const actionLabels: Record<LifecycleAction, string> = {
  resume: "Resume workspace",
  suspend: "Suspend workspace",
  destroy: "Destroy workspace",
  archive: "Archive workspace",
};

export function WorkspaceLifecycleControls({
  workspaceId,
  status,
}: {
  workspaceId: string;
  status: WorkspaceStatus;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);
  const [isPending, startTransition] = useTransition();
  const canSuspend = status === "ready" || status === "idle";
  const canResume = status === "suspended";
  const canArchive = status === "ready" || status === "idle";
  const isArchived = status === "archived";
  const canDestroy = canSuspend || canResume || isArchived || status === "failed";

  function perform(action: LifecycleAction) {
    if (
      action === "destroy" &&
      !window.confirm("Destroy this workspace? Its persistent files and worktree cannot be recovered.")
    ) {
      return;
    }

    setPendingAction(action);
    startTransition(async () => {
      setMessage(null);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/lifecycle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setMessage(result.error ?? `${actionLabels[action]} failed. Please try again.`);
          return;
        }
        router.refresh();
        if (action === "destroy") router.push("/workspaces");
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
      } finally {
        setPendingAction(null);
      }
    });
  }

  if (!canSuspend && !canResume && !canArchive && !canDestroy && !isArchived) {
    return (
      <p className="text-muted-foreground text-xs">
        Lifecycle controls are unavailable while this workspace is {status.replaceAll("_", " ")}.
      </p>
    );
  }

  const waiting = (action: LifecycleAction) => isPending && pendingAction === action;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canResume && (
          <Button disabled={isPending} onClick={() => perform("resume")} size="sm">
            {waiting("resume") ? <LoaderCircle className="animate-spin" /> : <Play />}
            {waiting("resume") ? "Resuming" : "Resume"}
          </Button>
        )}
        {canSuspend && (
          <Button disabled={isPending} onClick={() => perform("suspend")} size="sm" variant="outline">
            {waiting("suspend") ? <LoaderCircle className="animate-spin" /> : <Pause />}
            {waiting("suspend") ? "Suspending" : "Suspend"}
          </Button>
        )}
        {canArchive && (
          <Button disabled={isPending} onClick={() => perform("archive")} size="sm" variant="outline">
            {waiting("archive") ? <LoaderCircle className="animate-spin" /> : <Archive />}
            {waiting("archive") ? "Archiving" : "Archive"}
          </Button>
        )}
        {isArchived && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/workspaces/${workspaceId}/replay`}>
              <History /> Replay
            </Link>
          </Button>
        )}
        {canDestroy && (
          <Button disabled={isPending} onClick={() => perform("destroy")} size="sm" variant="destructive">
            {waiting("destroy") ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            {waiting("destroy") ? "Destroying" : "Destroy"}
          </Button>
        )}
      </div>
      {message && (
        <p aria-live="polite" className="text-destructive text-xs">
          {message}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {isArchived
          ? "This workspace is archived. Replay reads its Snapshot from storage — no Runtime Computer required."
          : canResume
            ? "Resuming starts fresh compute attached to this workspace’s persistent storage."
            : "Archiving captures a durable Snapshot (terminal, conversation, and git tree); suspending just stops compute."}
      </p>
    </div>
  );
}
