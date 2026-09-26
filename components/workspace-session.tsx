"use client";

import "@xterm/xterm/css/xterm.css";

import { RefreshCw, TerminalSquare, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
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
  const terminal = useSessionTerminal(attachment, terminalContainer, showTerminal);
  const conversation = useConversationStream(attachment);

  // The jcode engine has no PTY: prompts go over the /message API and the reply
  // streams back on the Conversation SSE. So input readiness and errors come
  // from the session attachment + conversation stream, not the terminal (which
  // stays available only as an optional shell panel).
  const error = conversation.error ?? attachment.error;
  const refresh = () => attachment.refresh();
  const canSend = attachment.status === "attached";

  // Optimistic echo: the prompt only reaches the timeline after Claude logs it
  // and the agent streams it back (a second or two). Show the user's own bubble
  // immediately and drop it once the streamed copy of that turn arrives, so the
  // composer feels instant without ever double-rendering the message.
  // Each pending item remembers the delivered-prompt count it is waiting to
  // exceed. Sends are serialized, so the Nth optimistic bubble is superseded
  // once the stream has recorded N prompts — independent of the text, so
  // duplicate messages and Claude's text-less tool-result user turns can't
  // confuse the match.
  const [pending, setPending] = useState<{ id: string; text: string; expect: number }[]>([]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      setPending((prev) => {
        const base = userPromptCount(conversation.events);
        // Drop items the stream has already caught up on, then queue this one to
        // wait for the next prompt slot. Trimming here (not in an effect) keeps
        // the list bounded without a setState-in-effect cascade.
        const live = prev.filter((p) => base < p.expect);
        const expect = Math.max(base + 1, live.length ? live[live.length - 1].expect + 1 : 0);
        return [...live, { id: crypto.randomUUID(), text: trimmed, expect }];
      });
    }
    void fetch(`/api/workspaces/${workspaceId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  };

  const timelineEvents = useMemo<AgentEvent[]>(() => {
    const delivered = userPromptCount(conversation.events);
    const optimistic = pending
      .filter((p) => delivered < p.expect)
      .map<AgentEvent>((p) => ({
        t: "message",
        uuid: `optimistic-${p.id}`,
        parentUuid: null,
        role: "user",
        timestamp: new Date().toISOString(),
        content: [{ type: "text", text: p.text }],
      }));
    return optimistic.length ? [...conversation.events, ...optimistic] : conversation.events;
  }, [conversation.events, pending]);

  // Fire the /new first prompt exactly once, as soon as we hold the keyboard.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (sentInitial.current) return;
    if (!initialPrompt || !canSend) return;
    sentInitial.current = true;
    // send() queues an optimistic bubble (setState); this is a one-time guarded
    // fire on ready, not a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    send(initialPrompt);
    // Strip ?prompt= from the URL so a refresh doesn't re-send it — the guard
    // above only covers this page load, not a fresh one.
    window.history.replaceState(null, "", window.location.pathname);
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
          <ConversationTimeline events={timelineEvents} />
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

/** Plain text of a message event's text blocks, trimmed to match how the agent
 *  records a typed prompt (Claude logs it as a string; the watcher trims it). */
function messageText(event: AgentEvent): string {
  if (event.t !== "message") return "";
  return event.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/** How many text-bearing user prompts the stream has recorded. Excludes Claude's
 *  tool-result turns, which are logged as role:"user" but carry no prompt text. */
function userPromptCount(events: AgentEvent[]): number {
  return events.filter((e) => e.t === "message" && e.role === "user" && messageText(e) !== "").length;
}
