"use client";

import { ChevronRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { Badge } from "@/components/ui/badge";
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
  const [message, setMessage] = useState<string | null>(null);
  // Maps (not plain objects) so a file named "toString"/"constructor" can't
  // collide with Object.prototype. Errors are tracked separately from successful
  // diffs so a transient failure isn't cached as a diff and re-expanding retries.
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  // Latest values for the poll to read without stale closures.
  const filesRef = useRef<ChangedFile[] | null>(null);
  const openRef = useRef<Set<string>>(openPaths);
  // Bumped whenever the changed set is reloaded; an in-flight diff load whose
  // generation no longer matches is discarded instead of caching a stale diff.
  const loadGen = useRef(0);
  // Serializes the changed-file requests (initial load + polls) so a slow
  // response can't overwrite a newer one, and only one runs at a time.
  const inFlight = useRef(false);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    openRef.current = openPaths;
  }, [openPaths]);

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
      const gen = loadGen.current;
      setLoadingPaths((s) => new Set(s).add(path));
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/changes?path=${encodeURIComponent(path)}`,
        );
        const result = (await response.json().catch(() => ({}))) as { diff?: string; error?: string };
        if (loadGen.current !== gen) return; // superseded by a reload — discard
        if (response.ok && typeof result.diff === "string") {
          const diff = result.diff;
          setDiffs((d) => new Map(d).set(path, diff));
          setDiffErrors((e) => {
            if (!e.has(path)) return e;
            const n = new Map(e);
            n.delete(path);
            return n;
          });
        } else {
          setDiffErrors((e) => new Map(e).set(path, result.error ?? "Could not load this diff."));
        }
      } catch {
        if (loadGen.current === gen) {
          setDiffErrors((e) => new Map(e).set(path, "Could not reach Runtime. Please try again."));
        }
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
      // Collapsed by default — just the file list; the diff loads when a file is
      // expanded. Bump the generation so any in-flight load is discarded.
      loadGen.current += 1;
      setOpenPaths(new Set());
      setDiffs(new Map());
      setDiffErrors(new Map());
    },
    [],
  );

  // Auto-load on mount. The first statement awaits, so no state is set
  // synchronously inside the effect body.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      inFlight.current = true;
      try {
        const result = await fetchChanges(controller.signal);
        if (!controller.signal.aborted) applyResult(result);
      } catch {
        if (!controller.signal.aborted) {
          setMessage("Could not reach Runtime. Please try again.");
          setFiles([]);
        }
      } finally {
        inFlight.current = false;
      }
    })();
    return () => {
      controller.abort();
      inFlight.current = false;
    };
  }, [active, fetchChanges, applyResult]);

  // Live refresh: poll the changed-file set while the panel is open so edits
  // appear without a manual refresh. Preserves the user's expand/collapse choices
  // and only reloads a diff for an expanded file whose +/- counts changed.
  const poll = useCallback(async () => {
    if (inFlight.current) return; // don't overlap the initial load or another poll
    inFlight.current = true;
    try {
      const result = await fetchChanges();
      if ("error" in result) return; // ignore a transient poll error; next tick retries
      const prevSig = new Map(
        (filesRef.current ?? []).map((f) => [f.path, `${f.additions}:${f.deletions}`]),
      );
      const present = new Set(result.files.map((f) => f.path));
      setMessage(null); // a successful poll clears any stale error banner
      setFiles(result.files);
      setOpenPaths((o) => new Set([...o].filter((p) => present.has(p))));
      for (const f of result.files) {
        if (!openRef.current.has(f.path)) continue;
        if (prevSig.get(f.path) !== `${f.additions}:${f.deletions}`) void loadDiff(f.path);
      }
    } catch {
      // Transient network failure — ignore; the next tick retries.
    } finally {
      inFlight.current = false;
    }
  }, [fetchChanges, loadDiff]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void poll(), 3500);
    return () => clearInterval(id);
  }, [active, poll]);

  const toggle = (path: string) => {
    setOpenPaths((s) => {
      const n = new Set(s);
      if (n.has(path)) {
        n.delete(path);
      } else {
        n.add(path);
        // Fetch on first expand, and retry after an error (errors aren't cached
        // as diffs, so `diffs.has` stays false until a load succeeds).
        if (!diffs.has(path) && !loadingPaths.has(path)) void loadDiff(path);
      }
      return n;
    });
  };

  if (!active) {
    return <div className="studio-changes-empty">Changes are available once the workspace is ready.</div>;
  }

  const hasChanges = !!files && files.length > 0;
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
      </div>

      <div className="studio-changes-scroll">
        {message && <p aria-live="polite" className="px-4 py-3 text-destructive text-xs">{message}</p>}
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
            const diff = diffs.get(file.path);
            const diffError = diffErrors.get(file.path);
            return (
              <div key={file.path} className="studio-diff-file">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(file.path)}
                  className="studio-diff-file-head"
                >
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
                    {diff !== undefined ? (
                      <DiffView diff={diff} />
                    ) : diffError !== undefined ? (
                      <p aria-live="polite" className="px-3 py-2 text-destructive text-xs">{diffError}</p>
                    ) : (
                      <p className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground text-xs">
                        <LoaderCircle className="size-3.5 animate-spin" /> Loading diff…
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
