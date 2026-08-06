import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeToolUse,
  formatTokens,
  summarizeToolResult,
  toolResultText,
} from "@/lib/runtime/conversation-format";

test("describeToolUse pulls the primary argument for common tools", () => {
  assert.equal(describeToolUse("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(
    describeToolUse("Read", { file_path: "/repo/index.ts" }),
    "/repo/index.ts",
  );
  assert.equal(
    describeToolUse("NotebookEdit", { notebook_path: "/repo/a.ipynb" }),
    "/repo/a.ipynb",
  );
  assert.equal(describeToolUse("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(describeToolUse("WebSearch", { query: "zod v4" }), "zod v4");
});

test("describeToolUse formats Grep with an optional path", () => {
  assert.equal(describeToolUse("Grep", { pattern: "TODO" }), "TODO");
  assert.equal(
    describeToolUse("Grep", { pattern: "TODO", path: "src" }),
    "TODO  in src",
  );
});

test("describeToolUse counts TodoWrite items with correct pluralization", () => {
  assert.equal(describeToolUse("TodoWrite", { todos: [{}] }), "1 item");
  assert.equal(describeToolUse("TodoWrite", { todos: [{}, {}] }), "2 items");
});

test("describeToolUse returns null when there is no good one-liner", () => {
  assert.equal(describeToolUse("UnknownTool", { foo: "bar" }), null);
  assert.equal(describeToolUse("Bash", {}), null);
  assert.equal(describeToolUse("Bash", { command: "   " }), null);
  assert.equal(describeToolUse("Read", null), null);
});

test("toolResultText normalizes strings, block arrays, and objects", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(
    toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    "a\nb",
  );
  assert.equal(toolResultText(null), "");
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText({ code: 1 }), '{\n  "code": 1\n}');
});

test("summarizeToolResult previews the first line and flags truncation", () => {
  const single = summarizeToolResult("just one line");
  assert.equal(single.preview, "just one line");
  assert.equal(single.truncated, false);
  assert.equal(single.lineCount, 1);

  const multi = summarizeToolResult("line 1\nline 2\nline 3");
  assert.equal(multi.preview, "line 1");
  assert.equal(multi.truncated, true);
  assert.equal(multi.lineCount, 3);
});

test("summarizeToolResult truncates an overlong first line", () => {
  const long = "x".repeat(200);
  const result = summarizeToolResult(long);
  assert.ok(result.preview.endsWith("…"));
  assert.ok(result.preview.length < long.length);
  assert.equal(result.truncated, true);
});

test("summarizeToolResult labels empty output", () => {
  const empty = summarizeToolResult("   ");
  assert.equal(empty.preview, "(empty result)");
  assert.equal(empty.lineCount, 0);
});

test("formatTokens adds separators and handles missing values", () => {
  assert.equal(formatTokens(1234567), "1,234,567");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(undefined), "—");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatTokens(Number.NaN), "—");
});
