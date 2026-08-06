"use client";

import "@xterm/xterm/css/xterm.css";

import { FileDiff, LoaderCircle, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ConversationTimeline } from "@/components/conversation-timeline";
import { Button } from "@/components/ui/button";
import { useCastPlayer } from "@/hooks/use-cast-player";
import type { AgentEvent, WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import type { Cast } from "@/lib/runtime/replay/cast";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";

type ReplayData = {
  snapshotId: string;
  manifest: SnapshotManifest;
  cast: Cast;
  events: AgentEvent[];
  patch: string;
  summary: WorkspaceSummary | null;
};

/**
 * Read-only Replay of an archived Workspace Session. Every projection — terminal
 * cast, conversation, diff — is reconstructed from the Snapshot in storage; no
 * Runtime Computer is involved (M4 invariant #2), so this works even after the
 * box is gone.
 */
export function WorkspaceReplay({
  workspaceId,
  snapshots,
}: {
  workspaceId: string;
  snapshots: WorkspaceSnapshot[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    snapshots[0]?.id ?? null,
  );
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const load = async () => {
      // Drop the previous Snapshot's artifacts immediately so a slow fetch never
      // pairs stale cast/conversation/diff with the newly-selected label.
      setData(null);
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/replay?snapshotId=${selectedId}`,
        );
        const body = (await res.json()) as ReplayData & { error?: string };
        if (!active) return;
        if (!res.ok) {
          setError(body.error ?? "Could not load this Snapshot.");
          setData(null);
        } else {
          setData(body);
        }
      } catch {
        if (active) setError("Could not load this Snapshot.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [workspaceId, selectedId]);

  if (snapshots.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        This workspace has no Snapshots yet. Archive it to capture one.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-3">
        <label className="text-muted-foreground text-xs" htmlFor="snapshot">
          Snapshot
        </label>
        <select
          id="snapshot"
          className="rounded-md border bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.archivedAt).toLocaleString()}
            </option>
          ))}
        </select>
        {loading && <LoaderCircle className="text-muted-foreground size-4 animate-spin" />}
      </div>

      {error && (
        <p aria-live="polite" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <CastPanel cast={data?.cast ?? null} />
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="border-b px-3 py-2 text-xs font-medium">Conversation</div>
          <div className="min-h-0 flex-1">
            <ConversationTimeline events={data?.events ?? []} />
          </div>
        </div>
      </div>

      <DiffPanel patch={data?.patch ?? ""} summary={data?.summary ?? null} />
    </div>
  );
}

function CastPanel({ cast }: { cast: Cast | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const player = useCastPlayer(cast, containerRef);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-medium">Terminal</span>
        <Button
          disabled={player.status === "empty"}
          onClick={player.toggle}
          size="sm"
          variant="outline"
        >
          {player.status === "playing" ? <Pause /> : <Play />}
          {player.status === "playing" ? "Pause" : "Play"}
        </Button>
        <input
          aria-label="Seek"
          className="flex-1"
          type="range"
          min={0}
          max={Math.max(player.duration, 0.001)}
          step={0.05}
          value={player.currentTime}
          onChange={(e) => player.seek(Number(e.target.value))}
        />
        <span className="text-muted-foreground w-24 text-right font-mono text-[11px]">
          {formatTime(player.currentTime)} / {formatTime(player.duration)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#0b0b0b] p-2">
        <div ref={containerRef} />
      </div>
    </div>
  );
}

function DiffPanel({
  patch,
  summary,
}: {
  patch: string;
  summary: WorkspaceSummary | null;
}) {
  return (
    <div className="flex max-h-64 min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <FileDiff className="size-4" /> Changes
        {summary && (
          <span className="text-muted-foreground font-normal">
            {summary.changedFiles} changed · {summary.commitCount} commit
            {summary.commitCount === 1 ? "" : "s"} · {summary.filesTouched.length} touched
          </span>
        )}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
        {patch.trim() === "" ? "No uncommitted changes captured." : patch}
      </pre>
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
