"use client";

import { Brain, ChevronRight, Loader2, Terminal, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

  // Auto-follow: keep pinned to the bottom as events arrive, unless the user
  // scrolled up (then honor their position). A plain scrollTop write — no
  // virtualizer — so there's no flushSync-during-render from measureElement.
  useEffect(() => {
    const el = parentRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div
      ref={parentRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className="min-h-0 flex-1 overflow-auto bg-background text-[13.5px] leading-relaxed text-foreground"
    >
      {events.length === 0 && (
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
          Waiting for Claude to speak…
        </div>
      )}
      {events.map((event, i) => (
        <div key={event.t === "message" ? event.uuid : `${event.t}-${i}`} className="px-4 py-2">
          <div className="mx-auto max-w-3xl">
            <EventRow event={event} />
          </div>
        </div>
      ))}
      {claudeIsWorking(events) && (
        <div className="px-4 py-2">
          <div className="mx-auto max-w-3xl">
            <WorkingIndicator />
          </div>
        </div>
      )}
    </div>
  );
}

/** Whether Claude is still working on the current turn — so the moving indicator
 *  shows through the whole thing, not just the gap before the first reply. It's
 *  working while the latest turn is the user's (a fresh prompt or a tool result
 *  it must act on), or while its own latest turn ended on thinking or a tool_use
 *  (more is coming). A turn that ends in text is Claude done and idle. */
function claudeIsWorking(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t !== "message") continue;
    const message = event as ConversationMessage;
    if (message.role === "user") return true;
    const last = message.content[message.content.length - 1];
    return last ? last.type !== "text" : false;
  }
  return false;
}

/** Live "Claude is working" affordance: a spinning glyph and an elapsed timer,
 *  so activity is visible instead of a still pane. Remounts (resetting the
 *  clock) each time we re-enter the working state. */
function WorkingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      <span>Working</span>
      <span className="font-mono text-[11px] text-muted-foreground/70">{(elapsed / 1000).toFixed(1)}s</span>
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  switch (event.t) {
    case "state":
      return (
        <div className="flex items-center gap-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="h-px w-4 bg-border" />
          session {event.state}
        </div>
      );
    case "usage":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 font-mono text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider text-muted-foreground">usage</span>
          <span>
            in <span className="text-foreground">{formatTokens(event.input_tokens)}</span>
          </span>
          <span>
            out <span className="text-foreground">{formatTokens(event.output_tokens)}</span>
          </span>
          <span>
            cache-r{" "}
            <span className="text-foreground">
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
        <div className="max-w-[80%] rounded-2xl bg-muted px-3.5 py-2.5 text-foreground">
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
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <Wrench className="size-3.5 shrink-0" />
        <span>{label}</span>
      </summary>
      <div className="mt-1 ml-[18px] space-y-1 border-l border-border pl-3">
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
        <div className="flex items-center gap-1.5 text-[11px] italic text-muted-foreground">
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
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {isBash ? (
          <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-medium text-foreground">{name}</span>
        {summary && (
          <span
            className={`truncate text-muted-foreground ${isBash ? "font-mono" : ""}`}
            title={summary}
          >
            {summary}
          </span>
        )}
      </summary>
      <pre className="mt-1 ml-[18px] overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
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
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          result
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={preview}>
          {preview}
        </span>
        {lineCount > 1 && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {lineCount} lines
          </span>
        )}
      </summary>
      {truncated && (
        <pre className="mt-1 ml-[18px] max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {text}
        </pre>
      )}
    </details>
  );
}
