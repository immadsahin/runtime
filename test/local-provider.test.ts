import assert from "node:assert/strict";
import { test } from "node:test";

import { isSafeRelativePath, parseChangedFiles } from "@/lib/runtime/local-provider";

test("isSafeRelativePath accepts ordinary repository paths", () => {
  assert.equal(isSafeRelativePath("src/index.ts"), true);
  assert.equal(isSafeRelativePath("a/b/c.txt"), true);
  assert.equal(isSafeRelativePath("has spaces.txt"), true);
});

test("isSafeRelativePath rejects traversal, absolute, pathspec magic, and dot", () => {
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath("../etc/passwd"), false);
  assert.equal(isSafeRelativePath("a/../b"), false);
  assert.equal(isSafeRelativePath("/etc/passwd"), false);
  assert.equal(isSafeRelativePath(":(top)"), false);
  assert.equal(isSafeRelativePath("./a"), false);
});

test("parseChangedFiles maps porcelain -z status codes", () => {
  const output = " M modified.ts\0?? untracked.txt\0A  added.ts\0 D gone.ts\0";
  const files = parseChangedFiles(output);
  assert.deepEqual(
    files.map((f) => [f.status, f.path]),
    [
      ["modified", "modified.ts"],
      ["untracked", "untracked.txt"],
      ["added", "added.ts"],
      ["deleted", "gone.ts"],
    ],
  );
});

test("parseChangedFiles consumes the original name of a rename entry", () => {
  const output = "R  after.ts\0before.ts\0";
  const files = parseChangedFiles(output);
  assert.deepEqual(files.map((f) => [f.status, f.path]), [["renamed", "after.ts"]]);
});
