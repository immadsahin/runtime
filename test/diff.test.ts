import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUnifiedDiff, type DiffLine } from "@/lib/runtime/diff";

const types = (lines: DiffLine[]) => lines.map((l) => l.type);

test("empty or whitespace input yields no lines", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  // A lone newline splits to two empty strings, both dropped.
  assert.deepEqual(parseUnifiedDiff("\n"), []);
});

test("classifies add / del / context and tracks gutter numbers per hunk", () => {
  const diff = [
    "diff --git a/foo.ts b/foo.ts",
    "index 111..222 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,3 +1,4 @@",
    " context",
    "-removed",
    "+added",
    "+added2",
    " tail",
  ].join("\n");

  const lines = parseUnifiedDiff(diff);
  // The 4 headers are meta, then the hunk, then 5 body lines.
  assert.deepEqual(types(lines), [
    "meta", "meta", "meta", "meta", "hunk",
    "context", "del", "add", "add", "context",
  ]);

  const body = lines.filter((l) => ["add", "del", "context"].includes(l.type));
  // context @ old1/new1; removed @ old2; added @ new2; added2 @ new3; tail @ old3/new4
  assert.equal(body[0].oldNumber, 1);
  assert.equal(body[0].newNumber, 1);
  assert.equal(body[1].type, "del");
  assert.equal(body[1].oldNumber, 2);
  assert.equal(body[1].newNumber, undefined);
  assert.equal(body[2].text, "added");
  assert.equal(body[2].newNumber, 2);
  assert.equal(body[3].newNumber, 3);
  assert.equal(body[4].oldNumber, 3);
  assert.equal(body[4].newNumber, 4);
});

test("strips only the leading marker, preserving line content and leading spaces", () => {
  const lines = parseUnifiedDiff(["@@ -1 +1 @@", "+  indented(add)", "-  indented(del)"].join("\n"));
  assert.equal(lines[1].text, "  indented(add)");
  assert.equal(lines[2].text, "  indented(del)");
});

test("empty add/del lines are handled (bare '+' / '-')", () => {
  const lines = parseUnifiedDiff(["@@ -1 +1 @@", "+", "-"].join("\n"));
  assert.equal(lines[1].type, "add");
  assert.equal(lines[1].text, "");
  assert.equal(lines[2].type, "del");
  assert.equal(lines[2].text, "");
});

test("multiple hunks reset the gutter to each hunk's start", () => {
  const diff = [
    "@@ -1,1 +1,1 @@",
    " a",
    "@@ -50,1 +60,1 @@",
    " b",
  ].join("\n");
  const ctx = parseUnifiedDiff(diff).filter((l) => l.type === "context");
  assert.equal(ctx[0].oldNumber, 1);
  assert.equal(ctx[0].newNumber, 1);
  assert.equal(ctx[1].oldNumber, 50);
  assert.equal(ctx[1].newNumber, 60);
});

test("file headers +++/--- are metadata, never add/del", () => {
  const lines = parseUnifiedDiff(["--- a/x", "+++ b/x", "@@ -1 +1 @@", "+real"].join("\n"));
  assert.deepEqual(types(lines), ["meta", "meta", "hunk", "add"]);
  assert.equal(lines[3].text, "real");
});

test("no-newline marker, rename, and binary notices are metadata", () => {
  const lines = parseUnifiedDiff(
    [
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "Binary files a/img.png and b/img.png differ",
      "@@ -1 +1 @@",
      "+x",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  assert.equal(lines.filter((l) => l.type === "meta").length, 5);
  assert.equal(lines.at(-1)?.type, "meta");
});

test("malformed hunk header does not throw and opens a hunk without gutter numbers", () => {
  const lines = parseUnifiedDiff(["@@ garbage @@", "+added"].join("\n"));
  assert.equal(lines[0].type, "hunk");
  assert.equal(lines[1].type, "add");
  assert.equal(lines[1].newNumber, undefined); // no valid hunk start → no numbering
});

test("body lines before any hunk carry no gutter numbers (defensive)", () => {
  const lines = parseUnifiedDiff("+orphan add");
  assert.equal(lines[0].type, "add");
  assert.equal(lines[0].newNumber, undefined);
});

test("CRLF line endings are normalized", () => {
  const lines = parseUnifiedDiff("@@ -1 +1 @@\r\n+added\r\n");
  assert.equal(lines[1].type, "add");
  assert.equal(lines[1].text, "added");
});
