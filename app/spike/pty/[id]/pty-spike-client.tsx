"use client";

import "@xterm/xterm/css/xterm.css";

import { useRef } from "react";

import { ConversationTimeline } from "@/components/conversation-timeline";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useSessionAttachment } from "@/hooks/use-session-attachment";
import { useSessionTerminal } from "@/hooks/use-session-terminal";

/**
 * PHASE-1/2 spike UI. Two independent live windows into the same Workspace
 * Session: xterm (PTY) on the left, virtualized Conversation Timeline (SSE)
 * on the right. Style is intentionally minimal — this is a correctness probe,
 * not the Workspace Experience.
 */
export function PtySpikeClient({
  workspaceId,
  branch,
}: {
  workspaceId: string;
  branch: string;
}) {
  const terminalContainer = useRef<HTMLDivElement>(null);
  const attachment = useSessionAttachment(workspaceId);
  const terminal = useSessionTerminal(attachment, terminalContainer);
  const conversation = useConversationStream(attachment);

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2 text-xs">
        <span className="font-mono text-neutral-400">phase-1/2 spike</span>
        <span className="text-neutral-300">
          workspace{" "}
          <span className="font-mono text-neutral-100">{workspaceId}</span>{" "}
          · branch <span className="font-mono text-neutral-100">{branch}</span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Label>terminal</Label>
          <StatusPill status={terminal.status} />
          <RolePill role={terminal.role} />
          {terminal.exitCode !== null && (
            <span className="rounded bg-yellow-900/50 px-2 py-0.5 text-yellow-200">
              exit {terminal.exitCode}
            </span>
          )}
          <span className="mx-2 text-neutral-700">·</span>
          <Label>conversation</Label>
          <StatusPill status={conversation.status} />
          <span className="rounded bg-neutral-800 px-2 py-0.5">
            {conversation.events.length} events
          </span>
          <button
            type="button"
            onClick={() => {
              terminal.refresh();
              conversation.refresh();
            }}
            className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700"
          >
            refresh
          </button>
        </div>
      </header>
      {(terminal.error || conversation.error) && (
        <div className="border-b border-red-800 bg-red-950/70 px-4 py-1 text-xs text-red-200">
          {terminal.error && <span>terminal: {terminal.error} </span>}
          {conversation.error && <span>conversation: {conversation.error}</span>}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={terminalContainer} className="min-h-0 flex-1" />
        <div className="w-[520px] min-w-[420px] border-l border-neutral-800">
          <ConversationTimeline events={conversation.events} />
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return <span className="text-neutral-500">{children}</span>;
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "bg-green-900/50 text-green-200"
      : status === "connecting" || status === "loading"
        ? "bg-blue-900/50 text-blue-200"
        : status === "disconnected"
          ? "bg-neutral-800 text-neutral-300"
          : "bg-red-900/50 text-red-200";
  return <span className={`rounded px-2 py-0.5 ${color}`}>{status}</span>;
}

function RolePill({ role }: { role: string }) {
  const color =
    role === "writer"
      ? "bg-purple-900/50 text-purple-200"
      : role === "reader"
        ? "bg-neutral-800 text-neutral-300"
        : "bg-neutral-800/50 text-neutral-500";
  return <span className={`rounded px-2 py-0.5 ${color}`}>{role}</span>;
}
