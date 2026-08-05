import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { toWorkspaceSnapshot } from "@/lib/db/mappers";
import type { Database } from "@/lib/supabase/database.types";

type Row = Database["public"]["Tables"]["workspace_snapshots"]["Row"];

const goldenManifest = (
  JSON.parse(
    readFileSync(
      path.join(process.cwd(), "lib/runtime/snapshot/manifest.fixtures.json"),
      "utf8",
    ),
  ) as { valid: unknown[] }
).valid[0];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "snap-1",
    owner_id: "owner-1",
    workspace_id: "ws-1",
    archived_at: "2026-08-05T12:30:00.000Z",
    storage_path: "archives/owner-1/ws-1/2026-08-05T12-30-00-000Z/",
    manifest: goldenManifest as Row["manifest"],
    policy: "manual_only",
    retention_days: null,
    created_at: "2026-08-05T12:31:00.000Z",
    updated_at: "2026-08-05T12:31:00.000Z",
    ...overrides,
  };
}

test("toWorkspaceSnapshot maps snake_case to camelCase", () => {
  const snap = toWorkspaceSnapshot(row());
  assert.equal(snap.id, "snap-1");
  assert.equal(snap.workspaceId, "ws-1");
  assert.equal(snap.archivedAt, "2026-08-05T12:30:00.000Z");
  assert.equal(snap.storagePath, "archives/owner-1/ws-1/2026-08-05T12-30-00-000Z/");
  assert.equal(snap.policy, "manual_only");
  assert.equal(snap.retentionDays, null);
  // owner_id is a db-layer concern and is not leaked onto the domain object.
  assert.equal("ownerId" in snap, false);
});

test("toWorkspaceSnapshot parses the manifest jsonb through the schema", () => {
  const snap = toWorkspaceSnapshot(row());
  assert.equal(snap.manifest.version, 1);
  assert.equal(snap.manifest.tree.kind, "git-bundle+patch");
  assert.equal(snap.manifest.changedFiles, 14);
});

test("toWorkspaceSnapshot throws on a malformed cached manifest", () => {
  assert.throws(() => toWorkspaceSnapshot(row({ manifest: { version: 99 } as Row["manifest"] })));
});

test("toWorkspaceSnapshot preserves a delete_after_n_days retention window", () => {
  const snap = toWorkspaceSnapshot(
    row({ policy: "delete_after_n_days", retention_days: 30 }),
  );
  assert.equal(snap.policy, "delete_after_n_days");
  assert.equal(snap.retentionDays, 30);
});
