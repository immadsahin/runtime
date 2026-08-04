import assert from "node:assert/strict";
import { test } from "node:test";

import { safeRelativePath } from "@/lib/auth/redirect";

test("safeRelativePath falls back for empty/nullish input", () => {
  assert.equal(safeRelativePath(null), "/");
  assert.equal(safeRelativePath(undefined), "/");
  assert.equal(safeRelativePath(""), "/");
  assert.equal(safeRelativePath(null, "/home"), "/home");
});

test("safeRelativePath keeps same-origin relative paths", () => {
  assert.equal(safeRelativePath("/"), "/");
  assert.equal(safeRelativePath("/workspaces/123"), "/workspaces/123");
});

test("safeRelativePath rejects open-redirect attempts", () => {
  assert.equal(safeRelativePath("//evil.com"), "/");
  assert.equal(safeRelativePath("/\\evil.com"), "/");
  assert.equal(safeRelativePath("https://evil.com"), "/");
  assert.equal(safeRelativePath("evil.com"), "/");
});
