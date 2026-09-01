"use client";

import "@xterm/xterm/css/xterm.css";

import { RefreshCw, TerminalSquare, Users } from "lucide-react";
import { useEffect, useRef } from "react";

import { ConversationTimeline } from "@/components/conversation-timeline";
import { SessionComposer } from "@/components/session-composer";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useSessionAttachment } from "@/hooks/use-session-attachment";
import { useSessionTerminal } from "@/hooks/use-session-terminal";

export function WorkspaceSession({
  workspaceId,
  showTerminal,
  initialPrompt,
}: {
  workspaceId: string;
  /** Whether the collapsible live terminal is revealed (owned by the studio). */
  showTerminal: boolean;
  /** First prompt to send once the session accepts input (from /new). */
  initialPrompt?: string;
}) {
  const terminalContainer = useRef<HTMLDivElement>(null);
  const attachment = useSessionAttachment(workspaceId);
  const terminal = useSessionTerminal(attachment, terminalContainer);
  const conversation = useConversationStream(attachment);

  // The jcode engine has no PTY: prompts go over the /message API and the reply
  // streams back on the Conversation SSE. So input readiness and errors come
  // from the session attachment + conversation stream, not the terminal (which
  // stays available only as an optional shell panel).
  const error = conversation.error ?? attachment.error;
  const refresh = () => attachment.refresh();
  const canSend = attachment.status === "attached";

  const send = (text: string) => {
    void fetch(`/api/workspaces/${workspaceId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  };

  // Fire the /new first prompt exactly once, as soon as we hold the keyboard.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (sentInitial.current) return;
    if (!initialPrompt || !canSend) return;
    sentInitial.current = true;
    send(initialPrompt);
    // send/terminal are stable enough; guard prevents a repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSend, initialPrompt]);

  return (
    <div className="studio-live-session" data-testid="workspace-session">
      {error && (
        <div className="studio-session-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={refresh}>Try again</button>
        </div>
      )}

      <section className="studio-convo-panel" aria-label="Claude conversation">
        <div className="studio-convo-body">
          <ConversationTimeline events={conversation.events} />
        </div>
      </section>

      <section
        className={`studio-term-panel${showTerminal ? "" : " is-hidden"}`}
        aria-label="Live Claude terminal"
      >
        <div className="studio-convo-head">
          <span className="studio-convo-title">
            <TerminalSquare /> Terminal
          </span>
          <span className="studio-terminal-role">
            <Users /> {terminal.role}
            <button
              type="button"
              onClick={refresh}
              className="studio-term-reconnect"
              title="Reconnect"
            >
              <RefreshCw />
            </button>
          </span>
        </div>
        <div ref={terminalContainer} className="studio-live-terminal" />
        {terminal.exitCode !== null && (
          <p className="studio-terminal-exit">
            Claude exited with code {terminal.exitCode}. Reconnect or start a new
            workspace to begin another session.
          </p>
        )}
      </section>

      <SessionComposer onSend={send} canSend={canSend} />
    </div>
  );
}
