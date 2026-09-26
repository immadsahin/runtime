"use client";

import { GitCommitHorizontal, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { commitMessageError } from "@/lib/runtime/commit";
import { cn } from "@/lib/utils";
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
  baseBranch,
}: {
  workspaceId: string;
  active: boolean;
  baseBranch?: string;
}) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Commit-from-UI (commit only; publish still owns commit+push+PR).
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Per-file diff cache: reselecting a file must not refetch (perf 1A). Cleared
  // whenever the changed-file set is reloaded.
  const diffCache = useRef<Map<string, string>>(new Map());

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
    diffCache.current.clear();
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
      const cached = diffCache.current.get(path);
      if (cached !== undefined) {
        setDiff(cached);
        setDiffLoading(false);
        return;
      }
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
        const value =
          response.ok && typeof result.diff === "string"
            ? result.diff
            : result.error ?? "Could not load this diff.";
        if (response.ok && typeof result.diff === "string") {
          diffCache.current.set(path, value);
        }
        setDiff(value);
      } catch {
        setDiff("Could not reach Runtime. Please try again.");
      } finally {
        setDiffLoading(false);
      }
    },
    [workspaceId],
  );

  const commit = useCallback(async () => {
    setCommitting(true);
    setCommitError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary, description }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setCommitError(result.error ?? "Could not commit.");
        return;
      }
      // Committed: clear the form and refetch the (now-empty) changed set.
      setSummary("");
      setDescription("");
      await refresh();
    } catch {
      setCommitError("Could not reach Runtime. Please try again.");
    } finally {
      setCommitting(false);
    }
  }, [workspaceId, summary, description, refresh]);

  if (!active) {
    return <div className="studio-changes-empty">Changes are available once the workspace is ready.</div>;
  }

  const hasChanges = !!files && files.length > 0;
  const canCommit = hasChanges && commitMessageError(summary) === null && !committing;
  const line = { borderColor: "var(--studio-line)" };

  return (
    <div className="studio-changes-split">
      {/* Left column: file list + commit form */}
      <div className="studio-changes-list">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5" style={line}>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">
              Changes{files ? ` (${files.length})` : ""}
            </p>
            {baseBranch && (
              <p className="truncate text-[11px] text-muted-foreground">Compared with {baseBranch}</p>
            )}
          </div>
          <Button disabled={loading} onClick={() => void refresh()} size="icon" variant="outline" title="Refresh">
            {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {message && <p aria-live="polite" className="px-3 py-2 text-destructive text-xs">{message}</p>}
          {files === null && !message && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground text-sm">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading changes…
            </p>
          )}
          {files && files.length === 0 && !message && (
            <p className="px-3 py-3 text-muted-foreground text-xs">No uncommitted changes.</p>
          )}
          {hasChanges && (
            <ul>
              {files!.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => void openDiff(file.path)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50",
                      selected === file.path && "bg-accent",
                    )}
                  >
                    <Badge variant={statusVariant[file.status]} className="shrink-0 capitalize">
                      {file.status}
                    </Badge>
                    <span className="truncate font-mono">{file.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasChanges && (
          <div className="space-y-2 border-t p-3" style={line}>
            <input
              aria-label="Commit summary"
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-ring"
              disabled={committing}
              maxLength={256}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Commit summary"
              value={summary}
            />
            <textarea
              aria-label="Commit description"
              className="min-h-16 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-ring"
              disabled={committing}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              value={description}
            />
            {commitError && <p aria-live="polite" className="text-destructive text-xs">{commitError}</p>}
            <Button className="w-full" disabled={!canCommit} onClick={() => void commit()} size="sm">
              {committing ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
              Commit {files!.length} file{files!.length === 1 ? "" : "s"}
            </Button>
          </div>
        )}
      </div>

      {/* Right column: the diff */}
      <div className="studio-changes-diff">
        {!selected ? (
          <div className="studio-changes-empty">
            {hasChanges ? "Select a file to view its diff." : "No changes to show."}
          </div>
        ) : diffLoading ? (
          <div className="studio-changes-empty">
            <LoaderCircle className="mr-2 size-4 animate-spin" /> Loading diff…
          </div>
        ) : (
          <div>
            <div
              className="sticky top-0 z-10 border-b px-4 py-2 font-mono text-xs break-all text-foreground"
              style={{ borderColor: "var(--studio-line)", background: "var(--studio-bg)" }}
            >
              {selected}
            </div>
            <div className="p-2">
              <DiffView diff={diff ?? ""} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
