/**
 * Unified-diff parser for the source-control panel's inline diff view.
 *
 * Pure and dependency-free so it is trivially unit-testable and reusable (the
 * git panel today; the tabbed diff pane / replay later). The agent/provider
 * already returns a *bounded, text-only* unified diff per file, so this only has
 * to classify lines for rendering — it never fetches or truncates.
 */

/** One rendered diff line. `oldNumber`/`newNumber` drive the gutter; they are
 *  absent for hunk headers, file metadata, and the no-newline marker. */
export type DiffLine = {
  type: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
  oldNumber?: number;
  newNumber?: number;
};

/** Parse `@@ -oldStart,oldLen +newStart,newLen @@` → the two start lines. A
 *  malformed header yields `null` so the caller degrades instead of throwing. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

/**
 * Classify a unified diff into renderable lines, tracking old/new line numbers
 * across hunks. Tolerant of malformed input: unknown lines become `meta`, a bad
 * hunk header still starts a hunk (without gutter numbers) rather than throwing.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff) return [];

  const lines: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    // File/metadata headers — checked before the single-char +/- cases so that
    // `+++ b/file` and `--- a/file` are never mistaken for added/removed lines.
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("Binary files") ||
      line.startsWith("\\ No newline")
    ) {
      lines.push({ type: "meta", text: line });
      continue;
    }

    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      if (header) {
        oldNumber = header.oldStart;
        newNumber = header.newStart;
        inHunk = true;
      }
      lines.push({ type: "hunk", text: line });
      continue;
    }

    // Body lines only carry gutter numbers once a hunk has been opened.
    if (line.startsWith("+")) {
      lines.push({ type: "add", text: line.slice(1), newNumber: inHunk ? newNumber : undefined });
      if (inHunk) newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({ type: "del", text: line.slice(1), oldNumber: inHunk ? oldNumber : undefined });
      if (inHunk) oldNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      lines.push({
        type: "context",
        text: line.slice(1),
        oldNumber: inHunk ? oldNumber : undefined,
        newNumber: inHunk ? newNumber : undefined,
      });
      if (inHunk) {
        oldNumber += 1;
        newNumber += 1;
      }
      continue;
    }

    // A blank trailing line from the final "\n" split is dropped; anything else
    // unrecognized is surfaced as metadata rather than lost.
    if (line !== "") lines.push({ type: "meta", text: line });
  }

  return lines;
}
