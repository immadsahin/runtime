"use client";

import { ChevronRight, GitCommitHorizontal, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

/**
 * Conductor-style changes panel: a single scrollable list of changed files, each
 * an inline expandable diff (open by default so diffs show without a click). No
 * separate "select a file" pane. Each file's diff is fetched lazily the first
 * time it's shown and cached in state.
 */
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
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  // Commit-from-UI (commit only; publish still owns commit+push+PR).
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const fetchChanges = useCallback(
    async (signal?: AbortSignal): Promise<{ files: ChangedFile[] } | { error: string }> => {
      const response = await fetch(`/api/workspaces/${workspaceId}/changes`, { signal });
      const result = (await response.json().catch(() => ({}))) as {
        files?: ChangedFile[];
        error?: string;
      };
      if (!response.ok || !result.files) return { error: result.error ?? "Could not load changes." };
      return { files: result.files };
    },
    [workspaceId],
  );

  const loadDiff = useCallback(
    async (path: string) => {
      setLoadingPaths((s) => new Set(s).add(path));
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/changes?path=${encodeURIComponent(path)}`,
        );
        const result = (await response.json().catch(() => ({}))) as { diff?: string; error?: string };
        const value =
          response.ok && typeof result.diff === "string"
            ? result.diff
            : result.error ?? "Could not load this diff.";
        setDiffs((d) => ({ ...d, [path]: value }));
      } catch {
        setDiffs((d) => ({ ...d, [path]: "Could not reach Runtime. Please try again." }));
      } finally {
        setLoadingPaths((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
      }
    },
    [workspaceId],
  );

  const applyResult = useCallback(
    (result: { files: ChangedFile[] } | { error: string }) => {
      if ("error" in result) {
        setMessage(result.error);
        setFiles([]);
        setOpenPaths(new Set());
        return;
      }
      setMessage(null);
      setFiles(result.files);
      // Open every changed file and load its diff so changes show automatically.
      const paths = result.files.map((f) => f.path);
      setOpenPaths(new Set(paths));
      setDiffs({});
      for (const p of paths) void loadDiff(p);
    },
    [loadDiff],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(null);
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

  const toggle = (path: string) => {
    setOpenPaths((s) => {
      const n = new Set(s);
      if (n.has(path)) {
        n.delete(path);
      } else {
        n.add(path);
        if (diffs[path] === undefined) void loadDiff(path);
      }
      return n;
    });
  };

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
  const totalAdd = files?.reduce((a, f) => a + f.additions, 0) ?? 0;
  const totalDel = files?.reduce((a, f) => a + f.deletions, 0) ?? 0;

  return (
    <div className="studio-changes">
      <div className="studio-changes-head">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">
            {hasChanges ? `${files!.length} file${files!.length === 1 ? "" : "s"} changed` : "Changes"}
            {hasChanges && (
              <span className="ml-2 font-mono text-[11px] font-normal">
                <span className="text-emerald-500">+{totalAdd}</span>{" "}
                <span className="text-red-400">-{totalDel}</span>
              </span>
            )}
          </p>
          {baseBranch && <p className="truncate text-[11px] text-muted-foreground">Compared with {baseBranch}</p>}
        </div>
        <Button disabled={loading} onClick={() => void refresh()} size="icon" variant="ghost" title="Refresh">
          {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      <div className="studio-changes-scroll">
        {message && <p className="px-4 py-3 text-destructive text-xs">{message}</p>}
        {files === null && !message && (
          <p className="flex items-center gap-1.5 px-4 py-3 text-muted-foreground text-sm">
            <LoaderCircle className="size-3.5 animate-spin" /> Loading changes…
          </p>
        )}
        {files && files.length === 0 && !message && (
          <p className="px-4 py-8 text-center text-muted-foreground text-xs">No uncommitted changes.</p>
        )}
        {hasChanges &&
          files!.map((file) => {
            const isOpen = openPaths.has(file.path);
            const pending = loadingPaths.has(file.path) && diffs[file.path] === undefined;
            return (
              <div key={file.path} className="studio-diff-file">
                <button type="button" onClick={() => toggle(file.path)} className="studio-diff-file-head">
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                  <Badge variant={statusVariant[file.status]} className="shrink-0 capitalize">
                    {file.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{file.path}</span>
                  <span className="shrink-0 font-mono text-[11px]">
                    <span className="text-emerald-500">+{file.additions}</span>{" "}
                    <span className="text-red-400">-{file.deletions}</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="studio-diff-file-body">
                    {pending ? (
                      <p className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground text-xs">
                        <LoaderCircle className="size-3.5 animate-spin" /> Loading diff…
                      </p>
                    ) : (
                      <DiffView diff={diffs[file.path] ?? ""} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {hasChanges && (
        <div className="studio-changes-commit">
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
  );
}
