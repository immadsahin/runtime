"use client";

import { Brain, ChevronDown, ChevronRight, Loader2, Sparkles, Terminal, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
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
      className="min-h-0 flex-1 overflow-auto bg-background text-[0.8125rem] leading-relaxed text-foreground"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-16 pb-16">
        {events.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
            Waiting for Claude to speak…
          </div>
        )}
        {buildNodes(events).map((node) => (
          <NodeRow key={node.key} node={node} />
        ))}
        {claudeIsWorking(events) && <WorkingIndicator />}
      </div>
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
    if (event.t === "state") {
      // A terminated session is never "working", whatever the last turn was.
      if (event.state === "exited" || event.state === "archived") return false;
      continue;
    }
    if (event.t !== "message") continue;
    if (event.role === "user") return true; // a prompt or a tool result awaiting Claude
    const last = event.content[event.content.length - 1];
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

/** A rendered row. Tool activity is grouped ACROSS messages (Claude emits each
 *  tool call as its own message), so a whole working run collapses into one
 *  summary instead of a wall of "1 tool call" rows. */
type Node =
  | { kind: "state"; key: string; state: string }
  | { kind: "usage"; key: string; event: Extract<AgentEvent, { t: "usage" }> }
  | { kind: "prompt"; key: string; text: string }
  | { kind: "prose"; key: string; text: string }
  | { kind: "activity"; key: string; blocks: ContentBlock[]; messages: number };

/** Flatten the event stream into render nodes, coalescing every consecutive
 *  thinking / tool_use / tool_result block — no matter how many messages they
 *  span — into a single collapsible activity node. User prompts and assistant
 *  prose break the run and render on their own. */
function buildNodes(events: AgentEvent[]): Node[] {
  const nodes: Node[] = [];
  let group: { blocks: ContentBlock[]; messages: number } | null = null;
  const flush = () => {
    if (group && group.blocks.length) {
      nodes.push({ kind: "activity", key: `act-${nodes.length}`, blocks: group.blocks, messages: group.messages });
    }
    group = null;
  };

  events.forEach((event, ei) => {
    if (event.t === "state") {
      flush();
      nodes.push({ kind: "state", key: `st-${ei}`, state: event.state });
      return;
    }
    if (event.t === "usage") {
      flush();
      nodes.push({ kind: "usage", key: `us-${ei}`, event });
      return;
    }
    let addedToGroup = false;
    event.content.forEach((block, bi) => {
      if (block.type === "text") {
        if (addedToGroup && group) {
          group.messages += 1;
          addedToGroup = false;
        }
        flush();
        const kind = event.role === "user" ? "prompt" : "prose";
        nodes.push({ kind, key: `${event.uuid}-${ei}-${bi}`, text: block.text });
        return;
      }
      if (!group) group = { blocks: [], messages: 0 };
      group.blocks.push(block);
      addedToGroup = true;
    });
    if (addedToGroup && group) group.messages += 1;
  });

  flush();
  return nodes;
}

function NodeRow({ node }: { node: Node }) {
  switch (node.kind) {
    case "state":
      return (
        <div className="flex items-center gap-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="h-px w-4 bg-border" />
          session {node.state}
        </div>
      );
    case "usage":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 font-mono text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider text-muted-foreground">usage</span>
          <span>
            in <span className="text-foreground">{formatTokens(node.event.input_tokens)}</span>
          </span>
          <span>
            out <span className="text-foreground">{formatTokens(node.event.output_tokens)}</span>
          </span>
          <span>
            cache-r{" "}
            <span className="text-foreground">{formatTokens(node.event.cache_read_input_tokens)}</span>
          </span>
        </div>
      );
    case "prompt":
      return (
        <div className="flex justify-end">
          <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-3xl bg-foreground/[0.07] px-4 py-2 text-[0.8125rem] leading-relaxed text-foreground">
            {node.text}
          </div>
        </div>
      );
    case "prose":
      return (
        <div className="min-w-0">
          <Markdown>{node.text}</Markdown>
        </div>
      );
    case "activity":
      return <ToolActivity blocks={node.blocks} />;
  }
}

/** One collapsed summary for a whole working run (Conductor / open-webui style):
 *  "Explored · Read a.ts, 2 Bash" or "Thought" for a reasoning-only run; expands
 *  to every step. */
function ToolActivity({ blocks }: { blocks: ContentBlock[] }) {
  const tools = blocks.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );
  const verb = tools.length === 0 ? "Thought" : "Explored";
  const summary = toolSummary(tools);

  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-sm text-muted-foreground hover:text-foreground">
        {tools.length === 0 ? (
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground/80">{verb}</span>
          {summary && <span className="ml-1 text-muted-foreground">{summary}</span>}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="mt-1.5 space-y-3 overflow-hidden rounded-2xl border border-border p-3">
        {blocks.map((block, i) => (
          <BlockRow key={i} block={block} />
        ))}
      </div>
    </details>
  );
}

/** cptr-style run summary: count-grouped tool names, e.g. "Read a.ts, 2 Bash". */
function toolSummary(tools: Extract<ContentBlock, { type: "tool_use" }>[]): string {
  if (tools.length === 0) return "";
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${n} ${name}` : name)).join(", ");
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
