"use client";

import "@xterm/xterm/css/xterm.css";

import { Activity, CircleDot, RefreshCw, TerminalSquare, Users } from "lucide-react";
import { useMemo, useRef } from "react";

import { ConversationTimeline } from "@/components/conversation-timeline";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useSessionAttachment } from "@/hooks/use-session-attachment";
import { useSessionTerminal } from "@/hooks/use-session-terminal";
import type { WorkspaceState } from "@/lib/runtime/agent-protocol";

export function WorkspaceSession({
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
  const sessionState = useMemo<WorkspaceState | null>(() => {
    for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
      const event = conversation.events[index];
      if (event.t === "state") return event.state;
    }
    return null;
  }, [conversation.events]);

  const error = terminal.error ?? conversation.error;
  const refresh = () => attachment.refresh();

  return (
    <div className="studio-live-session" data-testid="workspace-session">
      <div className="studio-session-banner">
        <div>
          <span className="studio-session-eyebrow">
            <Activity /> LIVE WORKSPACE SESSION
          </span>
          <p>
            Claude is working in <code>{branch}</code>. The terminal and timeline are
            independent views of this same session.
          </p>
        </div>
        <div className="studio-session-health" aria-live="polite">
          <SessionPill label="session" value={sessionState ?? "awaiting state"} />
          <SessionPill label="terminal" value={terminal.status} />
          <SessionPill label="timeline" value={conversation.status} />
          <button type="button" onClick={refresh} className="studio-session-refresh">
            <RefreshCw /> Reconnect
          </button>
        </div>
      </div>

      {error && (
        <div className="studio-session-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={refresh}>Try again</button>
        </div>
      )}

      <div className="studio-session-grid">
        <section className="studio-session-panel" aria-label="Claude conversation timeline">
          <div className="studio-session-panel-head">
            <div>
              <span className="studio-session-panel-title"><CircleDot /> Conversation</span>
              <small>Structured Claude events — never parsed from terminal output.</small>
            </div>
            <span>{conversation.events.length} events</span>
          </div>
          <div className="studio-session-timeline">
            <ConversationTimeline events={conversation.events} />
          </div>
        </section>

        <section className="studio-session-panel" aria-label="Live Claude terminal">
          <div className="studio-session-panel-head">
            <div>
              <span className="studio-session-panel-title"><TerminalSquare /> Terminal</span>
              <small>
                {terminal.role === "writer"
                  ? "You have the keyboard."
                  : terminal.role === "reader"
                    ? "Read-only while another viewer has the keyboard."
                    : "Negotiating keyboard access…"}
              </small>
            </div>
            <span className="studio-terminal-role">
              <Users /> {terminal.role}
            </span>
          </div>
          <div ref={terminalContainer} className="studio-live-terminal" />
          {terminal.exitCode !== null && (
            <p className="studio-terminal-exit">
              Claude exited with code {terminal.exitCode}. Start a new workspace to begin another session.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function SessionPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="studio-session-pill">
      <small>{label}</small> {value}
    </span>
  );
}
