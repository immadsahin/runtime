import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  SNAPSHOT_ARTIFACTS,
  SnapshotManifest,
  parseManifest,
} from "@/lib/runtime/snapshot/manifest";

/**
 * The golden fixtures round-trip through the schema (the happy path), and a
 * table of deliberately-malformed manifests each asserts the SPECIFIC field
 * that fails. Strictness and the tree discriminated union are the parts most
 * likely to regress, so they get explicit negative coverage.
 */
const fixtures = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "lib/runtime/snapshot/manifest.fixtures.json"),
    "utf8",
  ),
) as { valid: unknown[] };

test("golden manifests round-trip through the schema", () => {
  assert.ok(fixtures.valid.length > 0, "expected golden fixtures");
  for (const example of fixtures.valid) {
    const parsed = parseManifest(example);
    // Re-parse the parsed output: schema output must itself be valid input.
    assert.deepEqual(SnapshotManifest.parse(parsed), parsed);
  }
});

/** A valid manifest we mutate per negative case. */
function base(): Record<string, unknown> {
  return structuredClone(fixtures.valid[0]) as Record<string, unknown>;
}

/** Assert that `value` fails and at least one issue points at `pathSegment`. */
function assertFailsAt(value: unknown, pathSegment: string) {
  const result = SnapshotManifest.safeParse(value);
  assert.equal(result.success, false, `expected failure for ${pathSegment}`);
  if (!result.success) {
    const hit = result.error.issues.some((i) => i.path.includes(pathSegment));
    assert.ok(
      hit,
      `expected an issue at "${pathSegment}", got ${JSON.stringify(
        result.error.issues.map((i) => i.path),
      )}`,
    );
  }
}

test("rejects an unknown top-level key (strict)", () => {
  const m = base();
  m.extra = "nope";
  assert.equal(SnapshotManifest.safeParse(m).success, false);
});

test("rejects a wrong version", () => {
  const m = base();
  m.version = 2;
  assertFailsAt(m, "version");
});

test("rejects an unknown tree.kind", () => {
  const m = base();
  m.tree = { kind: "oci-layer", bundle: "x", patch: "y" };
  assertFailsAt(m, "tree");
});

test("rejects a tree missing its patch pointer", () => {
  const m = base();
  m.tree = { kind: "git-bundle+patch", bundle: SNAPSHOT_ARTIFACTS.bundle };
  assertFailsAt(m, "tree");
});

test("rejects a mis-named artifact pointer", () => {
  const m = base();
  m.conversation = "chat.jsonl";
  assertFailsAt(m, "conversation");
});

test("rejects a malformed checksum", () => {
  const m = base();
  m.checksums = { "session.cast": "md5:deadbeef" };
  assertFailsAt(m, "checksums");
});

test("rejects a negative size", () => {
  const m = base();
  m.sizes = { "session.cast": -1 };
  assertFailsAt(m, "sizes");
});

test("rejects a negative changedFiles count", () => {
  const m = base();
  m.changedFiles = -3;
  assertFailsAt(m, "changedFiles");
});

test("accepts null sessionId / lastCommit / lastMessage (empty session)", () => {
  const m = base();
  m.sessionId = null;
  m.lastCommit = null;
  m.lastMessage = null;
  assert.equal(SnapshotManifest.safeParse(m).success, true);
});

test("rejects a non-string sessionId (null is allowed, number is not)", () => {
  const m = base();
  m.sessionId = 42;
  assertFailsAt(m, "sessionId");
});
