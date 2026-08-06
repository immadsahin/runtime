"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SyncResponse = { synced?: number; discovered?: number; error?: string };

export function ProjectsSyncButton({
  align = "end",
}: {
  align?: "start" | "center" | "end";
}) {
  const router = useRouter();
  const [isSyncing, startSync] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function sync() {
    startSync(async () => {
      setMessage(null);
      let response: Response;
      try {
        response = await fetch("/api/projects/sync", { method: "POST" });
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
        return;
      }

      const result = (await response.json().catch(() => ({}))) as SyncResponse;
      if (!response.ok) {
        setMessage(result.error ?? "Repository sync failed. Please try again.");
        return;
      }

      const discovered = result.discovered ?? 0;
      setMessage(
        discovered === 1
          ? "1 repository synchronized."
          : `${discovered} repositories synchronized.`,
      );
      router.refresh();
    });
  }

  const alignment =
    align === "center"
      ? "items-center text-center"
      : align === "start"
        ? "items-start text-left"
        : "items-end text-right";

  return (
    <div className={cn("flex flex-col gap-1.5", alignment)}>
      <Button onClick={sync} disabled={isSyncing} size="sm">
        <RefreshCw className={isSyncing ? "animate-spin" : undefined} />
        {isSyncing ? "Synchronizing" : "Sync repositories"}
      </Button>
      {message && (
        <p aria-live="polite" className="text-muted-foreground max-w-64 text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
