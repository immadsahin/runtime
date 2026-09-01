"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Brain, ChevronRight, Terminal, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";

import { Markdown } from "@/components/markdown";
import type {
  AgentEvent,
  ContentBlock,
  ConversationMessage,
} from "@/lib/runtime/agent-protocol";
import {
  describeToolUse,
  formatTokens,
  summarizeToolResult,
} from "@/lib/runtime/conversation-format";

/**
 * The Conversation projection of the Workspace Session — a virtualized ordered
 * list of AgentEvents rendered as a light, sleek chat. Every entry comes from
 * one AgentEvent; nothing is derived from PTY output (see
 * docs/architecture/session-contract.md). Assistant prose renders as a bordered
 * card, user turns as a right-aligned bubble, and tool activity as muted lines.
 */
export function ConversationTimeline({ events }: { events: AgentEvent[] }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 8,
  });

  // Auto-follow: keep pinned to the bottom as events arrive, unless the user
  // scrolled up (then honor their position).
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
      className="h-full min-h-0 overflow-auto bg-white text-[13.5px] leading-relaxed text-neutral-800"
    >
      {events.length === 0 && (
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-6 text-sm text-neutral-400">
          <span className="size-1.5 animate-pulse rounded-full bg-neutral-300" />
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
              className="px-4 py-2"
            >
              <div className="mx-auto max-w-3xl">
                <EventRow event={event} />
              </div>
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
        <div className="flex items-center gap-2 py-1 text-[10px] font-medium uppercase tracking-wider text-neutral-400">
          <span className="h-px w-4 bg-neutral-200" />
          session {event.state}
        </div>
      );
    case "usage":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 font-mono text-[10px] text-neutral-400">
          <span className="uppercase tracking-wider text-neutral-400">usage</span>
          <span>
            in <span className="text-neutral-600">{formatTokens(event.input_tokens)}</span>
          </span>
          <span>
            out <span className="text-neutral-600">{formatTokens(event.output_tokens)}</span>
          </span>
          <span>
            cache-r{" "}
            <span className="text-neutral-600">
              {formatTokens(event.cache_read_input_tokens)}
            </span>
          </span>
        </div>
      );
    case "message":
      return <MessageRow message={event} />;
  }
}

function MessageRow({ message }: { message: ConversationMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-neutral-100 px-3.5 py-2.5 text-neutral-800">
          {message.content.map((block, i) => (
            <BlockRow key={i} block={block} />
          ))}
        </div>
      </div>
    );
  }
  // Conductor-style: assistant prose is the surface; thinking + tool activity
  // collapse into one expandable summary per run, so the timeline reads as a
  // conversation, not a tool log.
  const segments = groupContent(message.content);
  return (
    <div className="min-w-0 space-y-2">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Markdown key={i}>{seg.text}</Markdown>
        ) : (
          <ToolActivity key={i} blocks={seg.blocks} />
        ),
      )}
    </div>
  );
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "tools"; blocks: ContentBlock[] };

/** Split a message's blocks into prose runs and collapsible tool-activity runs
 *  (consecutive thinking / tool_use / tool_result blocks). */
function groupContent(blocks: ContentBlock[]): Segment[] {
  const segments: Segment[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      segments.push({ kind: "text", text: block.text });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === "tools") last.blocks.push(block);
    else segments.push({ kind: "tools", blocks: [block] });
  }
  return segments;
}

/** One collapsed "› N tool calls" summary; expands to the individual calls. */
function ToolActivity({ blocks }: { blocks: ContentBlock[] }) {
  const toolCount = blocks.filter((b) => b.type === "tool_use").length;
  const hasThinking = blocks.some((b) => b.type === "thinking");
  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
  if (hasThinking) parts.push("thinking");
  const label = parts.join(" · ") || "details";

  return (
    <details className="group rounded-md">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-[12px] text-neutral-400 hover:text-neutral-600">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <Wrench className="size-3.5 shrink-0" />
        <span>{label}</span>
      </summary>
      <div className="mt-1 ml-[18px] space-y-1 border-l border-neutral-100 pl-3">
        {blocks.map((block, i) => (
          <BlockRow key={i} block={block} />
        ))}
      </div>
    </details>
  );
}

function BlockRow({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      // Assistant prose renders plain on white (per the light reference); the
      // user bubble supplies its own container.
      return <Markdown>{block.text}</Markdown>;
    case "thinking":
      return (
        <div className="flex items-center gap-1.5 text-[11px] italic text-neutral-400">
          <Brain className="size-3" />
          Thinking
        </div>
      );
    case "tool_use":
      return <ToolUseRow name={block.name} input={block.input} />;
    case "tool_result":
      return <ToolResultRow content={block.content} />;
  }
}

function ToolUseRow({ name, input }: { name: string; input: unknown }) {
  const summary = describeToolUse(name, input);
  const isBash = name === "Bash";
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-[12px]">
        <ChevronRight className="size-3 shrink-0 text-neutral-300 transition-transform group-open:rotate-90" />
        {isBash ? (
          <Terminal className="size-3.5 shrink-0 text-neutral-400" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-neutral-400" />
        )}
        <span className="shrink-0 font-medium text-neutral-600">{name}</span>
        {summary && (
          <span
            className={`truncate text-neutral-400 ${isBash ? "font-mono" : ""}`}
            title={summary}
          >
            {summary}
          </span>
        )}
      </summary>
      <pre className="mt-1 ml-[18px] overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-500">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

function ToolResultRow({ content }: { content: unknown }) {
  const { text, preview, truncated, lineCount } = summarizeToolResult(content);
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-[12px]">
        <ChevronRight className="size-3 shrink-0 text-neutral-300 transition-transform group-open:rotate-90" />
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-neutral-400">
          result
        </span>
        <span className="truncate font-mono text-[11px] text-neutral-400" title={preview}>
          {preview}
        </span>
        {lineCount > 1 && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-300">
            {lineCount} lines
          </span>
        )}
      </summary>
      {truncated && (
        <pre className="mt-1 ml-[18px] max-h-96 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-neutral-500">
          {text}
        </pre>
      )}
    </details>
  );
}
