"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";

import type {
  AgentEvent,
  ContentBlock,
  ConversationMessage,
} from "@/lib/runtime/agent-protocol";

/**
 * The Conversation projection of the Workspace Session — a virtualized ordered
 * list of AgentEvents. NOT a chat view. Every entry is rendered from one
 * AgentEvent without any derivation from PTY output or heuristics: the event
 * stream is the source of truth (see docs/architecture/session-contract.md).
 *
 * Rendering is intentionally minimal in Phase 2: correctness > polish. Fancy
 * grouping / markdown / syntax highlighting / collapsing thinking is deferred
 * to Phase 7 dogfood insights.
 */
export function ConversationTimeline({ events }: { events: AgentEvent[] }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 8,
  });

  // Auto-follow: scroll to the bottom when new events arrive, but only if the
  // user hasn't scrolled up. Simple heuristic: if we were near-bottom before
  // the new event, stay near-bottom. If they scrolled away, honor that.
  useEffect(() => {
    if (!stickToBottom.current) return;
    if (events.length === 0) return;
    virtualizer.scrollToIndex(events.length - 1, { align: "end" });
  }, [events.length, virtualizer]);

  return (
    <div
      ref={parentRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className="h-full min-h-0 overflow-auto bg-neutral-950 font-mono text-xs text-neutral-200"
    >
      {events.length === 0 && (
        <div className="p-3 text-neutral-500">
          Waiting for Claude to speak…
        </div>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const event = events[row.index];
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transform: `translateY(${row.start}px)`,
                width: "100%",
              }}
              className="border-b border-neutral-900 px-3 py-2"
            >
              <EventRow event={event} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  switch (event.t) {
    case "state":
      return (
        <div className="text-[10px] uppercase tracking-wider text-neutral-500">
          state · {event.state}
        </div>
      );
    case "usage":
      return (
        <div className="text-[10px] text-neutral-500">
          usage · in {event.input_tokens} · out {event.output_tokens} · cache-r{" "}
          {event.cache_read_input_tokens}
        </div>
      );
    case "message":
      return <MessageRow message={event} />;
  }
}

function MessageRow({ message }: { message: ConversationMessage }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">
        {message.role}
      </div>
      {message.content.map((block, i) => (
        <BlockRow key={i} block={block} />
      ))}
    </div>
  );
}

function BlockRow({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <pre className="whitespace-pre-wrap text-neutral-100">{block.text}</pre>;
    case "thinking":
      return (
        <div className="text-[10px] italic text-neutral-500">
          thinking…
        </div>
      );
    case "tool_use":
      return (
        <div className="rounded bg-neutral-900 p-2 text-neutral-300">
          <span className="text-purple-300">tool</span>{" "}
          <span className="font-semibold">{block.name}</span>
          <pre className="mt-1 whitespace-pre-wrap text-neutral-400">
            {JSON.stringify(block.input, null, 2)}
          </pre>
        </div>
      );
    case "tool_result":
      return (
        <div className="rounded bg-neutral-900 p-2 text-neutral-400">
          <span className="text-blue-300">tool-result</span>{" "}
          <span className="text-neutral-500">→ {block.toolUseId}</span>
          <pre className="mt-1 whitespace-pre-wrap">
            {typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content, null, 2)}
          </pre>
        </div>
      );
  }
}
