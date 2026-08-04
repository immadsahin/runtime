"use client";

import { FileDiff, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChangedFile } from "@/lib/runtime/types";

const statusVariant: Record<ChangedFile["status"], "default" | "secondary" | "outline" | "destructive"> = {
  added: "default",
  modified: "secondary",
  deleted: "destructive",
  renamed: "outline",
  untracked: "outline",
};

export function WorkspaceChanges({
  workspaceId,
  active,
}: {
  workspaceId: string;
  active: boolean;
}) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const fetchChanges = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<{ files: ChangedFile[] } | { error: string }> => {
      const response = await fetch(`/api/workspaces/${workspaceId}/changes`, { signal });
      const result = (await response.json().catch(() => ({}))) as {
        files?: ChangedFile[];
        error?: string;
      };
      if (!response.ok || !result.files) {
        return { error: result.error ?? "Could not load changes." };
      }
      return { files: result.files };
    },
    [workspaceId],
  );

  const applyResult = useCallback(
    (result: { files: ChangedFile[] } | { error: string }) => {
      if ("error" in result) {
        setMessage(result.error);
        setFiles([]);
      } else {
        setFiles(result.files);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    setSelected(null);
    setDiff(null);
    try {
      applyResult(await fetchChanges());
    } catch {
      setMessage("Could not reach Runtime. Please try again.");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [fetchChanges, applyResult]);

  // Auto-load on mount. The first statement awaits, so no state is set
  // synchronously inside the effect body.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await fetchChanges(controller.signal);
        if (!controller.signal.aborted) applyResult(result);
      } catch {
        if (!controller.signal.aborted) {
          setMessage("Could not reach Runtime. Please try again.");
          setFiles([]);
        }
      }
    })();
    return () => controller.abort();
  }, [active, fetchChanges, applyResult]);

  const openDiff = useCallback(
    async (path: string) => {
      setSelected(path);
      setDiff(null);
      setDiffLoading(true);
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/changes?path=${encodeURIComponent(path)}`,
        );
        const result = (await response.json().catch(() => ({}))) as {
          diff?: string;
          error?: string;
        };
        setDiff(response.ok && typeof result.diff === "string" ? result.diff : result.error ?? "Could not load this diff.");
      } catch {
        setDiff("Could not reach Runtime. Please try again.");
      } finally {
        setDiffLoading(false);
      }
    },
    [workspaceId],
  );

  if (!active) {
    return (
      <p className="text-muted-foreground text-sm">
        Changes are available once the workspace is ready.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Uncommitted changes in the active worktree.
        </p>
        <Button disabled={loading} onClick={() => void refresh()} size="sm" variant="outline">
          {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>

      {message && (
        <p aria-live="polite" className="text-destructive text-xs">
          {message}
        </p>
      )}

      {files === null && !message && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading changes…
        </p>
      )}

      {files && files.length === 0 && !message && (
        <p className="text-muted-foreground text-sm">
          No uncommitted changes in this workspace.
        </p>
      )}

      {files && files.length > 0 && (
        <ul className="divide-y rounded-md border">
          {files.map((file) => (
            <li key={file.path}>
              <button
                className="hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                onClick={() => void openDiff(file.path)}
                type="button"
              >
                <Badge variant={statusVariant[file.status]} className="shrink-0 capitalize">
                  {file.status}
                </Badge>
                <span className="truncate font-mono text-xs">{file.path}</span>
                {selected === file.path && <FileDiff className="text-muted-foreground ml-auto size-3.5 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="space-y-1.5">
          <p className="font-mono text-xs break-all">{selected}</p>
          {diffLoading ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading diff…
            </p>
          ) : (
            <pre className="bg-muted/50 max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
              {diff}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
