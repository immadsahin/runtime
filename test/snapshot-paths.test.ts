import assert from "node:assert/strict";
import { test } from "node:test";

import { SNAPSHOT_ARTIFACTS } from "@/lib/runtime/snapshot/manifest";
import {
  archivedAtSegment,
  snapshotArtifactPath,
  snapshotArtifactPaths,
  snapshotPrefix,
} from "@/lib/runtime/snapshot/paths";

test("archivedAtSegment makes an ISO timestamp object-key-safe", () => {
  assert.equal(
    archivedAtSegment("2026-08-05T12:30:00.000Z"),
    "2026-08-05T12-30-00-000Z",
  );
});

test("snapshotPrefix is owner-scoped, then workspace, then time", () => {
  const prefix = snapshotPrefix("owner-1", "ws-2", "2026-08-05T12:30:00.000Z");
  assert.equal(prefix, "archives/owner-1/ws-2/2026-08-05T12-30-00-000Z/");
  // Owner segment comes first so path-based scoping aligns with per-owner RLS.
  assert.ok(prefix.startsWith("archives/owner-1/"));
});

test("snapshotArtifactPath joins prefix + artifact filename", () => {
  const prefix = snapshotPrefix("o", "w", "2026-08-05T12:30:00.000Z");
  assert.equal(
    snapshotArtifactPath(prefix, "manifest"),
    `${prefix}${SNAPSHOT_ARTIFACTS.manifest}`,
  );
});

test("snapshotArtifactPaths covers every declared artifact exactly once", () => {
  const prefix = snapshotPrefix("o", "w", "2026-08-05T12:30:00.000Z");
  const paths = snapshotArtifactPaths(prefix);
  const keys = Object.keys(paths).sort();
  assert.deepEqual(keys, Object.keys(SNAPSHOT_ARTIFACTS).sort());
  for (const [artifact, filename] of Object.entries(SNAPSHOT_ARTIFACTS)) {
    assert.equal(paths[artifact as keyof typeof SNAPSHOT_ARTIFACTS], `${prefix}${filename}`);
  }
});
