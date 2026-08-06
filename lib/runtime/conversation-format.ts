/**
 * Pure presentation helpers for the Conversation Timeline. Kept free of JSX so
 * the logic is unit-testable under the plain `node --test` runner and reused by
 * `components/conversation-timeline.tsx` without duplication.
 *
 * None of this derives meaning from PTY output — it only reshapes the already
 * structured AgentEvent payloads (see agent-protocol.ts) for display.
 */

/** Read a string field off an unknown tool-input object without throwing. */
function field(input: unknown, key: string): string | null {
  if (input && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * A concise, human-readable summary of a tool call — the single most relevant
 * argument for the common Claude Code tools (the command, the file, the query).
 * Returns null when we don't have a good one-liner, so the caller can fall back
 * to the raw input.
 */
export function describeToolUse(name: string, input: unknown): string | null {
  switch (name) {
    case "Bash":
      return field(input, "command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return field(input, "file_path") ?? field(input, "notebook_path");
    case "Glob":
      return field(input, "pattern");
    case "Grep": {
      const pattern = field(input, "pattern");
      const path = field(input, "path");
      if (!pattern) return null;
      return path ? `${pattern}  in ${path}` : pattern;
    }
    case "LS":
      return field(input, "path");
    case "WebFetch":
      return field(input, "url");
    case "WebSearch":
      return field(input, "query");
    case "Task":
    case "Agent":
      return field(input, "description");
    case "TodoWrite": {
      if (
        input &&
        typeof input === "object" &&
        Array.isArray((input as Record<string, unknown>).todos)
      ) {
        const count = ((input as Record<string, unknown>).todos as unknown[])
          .length;
        return `${count} ${count === 1 ? "item" : "items"}`;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Normalize an unknown tool_result `content` payload to a plain string. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  // Claude tool results are often an array of `{ type: "text", text }` blocks.
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return JSON.stringify(block, null, 2);
    });
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content, null, 2);
}

export interface ResultSummary {
  /** The full normalized text, for the expanded view. */
  text: string;
  /** A single-line preview for the collapsed header. */
  preview: string;
  /** Whether there's more to reveal than the preview shows. */
  truncated: boolean;
  /** Total line count, useful as an at-a-glance size cue. */
  lineCount: number;
}

const PREVIEW_CHARS = 140;

/** Collapse a tool result into a preview + expandable full text. */
export function summarizeToolResult(content: unknown): ResultSummary {
  const text = toolResultText(content);
  const trimmed = text.trim();
  const lineCount = trimmed === "" ? 0 : trimmed.split("\n").length;
  const firstLine = trimmed.split("\n", 1)[0] ?? "";

  let preview = firstLine;
  let truncated = lineCount > 1;
  if (preview.length > PREVIEW_CHARS) {
    preview = `${preview.slice(0, PREVIEW_CHARS)}…`;
    truncated = true;
  }
  if (trimmed === "") preview = "(empty result)";

  return { text, preview, truncated, lineCount };
}

/** Format a token count with thousands separators; "—" for missing values. */
export function formatTokens(value: number | undefined | null): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US");
}
