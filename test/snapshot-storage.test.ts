import assert from "node:assert/strict";
import { test } from "node:test";

import { SNAPSHOT_ARTIFACTS } from "@/lib/runtime/snapshot/manifest";
import {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  isWithinOwnerScope,
  mintSnapshotDownloadUrl,
  mintSnapshotUpload,
  mintSnapshotUploadUrls,
  planSnapshotUpload,
  snapshotManifestPath,
  type SnapshotStorage,
} from "@/lib/runtime/storage/snapshots";

/** In-memory SnapshotStorage that records calls — no network. */
class FakeStorage implements SnapshotStorage {
  uploadCalls: string[] = [];
  downloadCalls: { path: string; expiresIn: number }[] = [];

  async createSignedUploadUrl(path: string) {
    this.uploadCalls.push(path);
    return { signedUrl: `https://signed/upload/${path}`, token: `tok:${path}`, path };
  }

  async createSignedDownloadUrl(path: string, expiresIn: number) {
    this.downloadCalls.push({ path, expiresIn });
    return { signedUrl: `https://signed/download/${path}?exp=${expiresIn}` };
  }
}

const OWNER = "owner-1";
const ARCHIVED_AT = "2026-08-05T12:30:00.000Z";

test("planSnapshotUpload covers every artifact under the owner-scoped prefix", () => {
  const plan = planSnapshotUpload(OWNER, "ws-2", ARCHIVED_AT);
  assert.equal(plan.prefix, "archives/owner-1/ws-2/2026-08-05T12-30-00-000Z/");
  const artifacts = plan.targets.map((t) => t.artifact).sort();
  assert.deepEqual(artifacts, Object.keys(SNAPSHOT_ARTIFACTS).sort());
  for (const t of plan.targets) {
    assert.ok(t.path.startsWith(plan.prefix), `${t.path} not under prefix`);
  }
});

test("isWithinOwnerScope confines to the owner and rejects traversal / cross-owner", () => {
  const prefix = planSnapshotUpload(OWNER, "ws", ARCHIVED_AT).prefix;
  assert.equal(isWithinOwnerScope(`${prefix}manifest.json`, OWNER), true);
  assert.equal(isWithinOwnerScope(`${prefix}manifest.json`, "owner-2"), false);
  assert.equal(isWithinOwnerScope("archives/owner-1/../owner-2/x", OWNER), false);
  assert.equal(isWithinOwnerScope("secrets/owner-1/x", OWNER), false);
});

test("mintSnapshotUploadUrls fans out to every target and keys the result", async () => {
  const storage = new FakeStorage();
  const plan = planSnapshotUpload(OWNER, "ws", ARCHIVED_AT);
  const urls = await mintSnapshotUploadUrls(storage, plan);

  assert.equal(urls.length, plan.targets.length);
  assert.deepEqual(storage.uploadCalls.sort(), plan.targets.map((t) => t.path).sort());
  for (const u of urls) {
    assert.equal(u.token, `tok:${u.path}`);
    assert.equal(u.signedUrl, `https://signed/upload/${u.path}`);
  }
});

test("mintSnapshotUpload returns the prefix alongside the minted URLs", async () => {
  const storage = new FakeStorage();
  const { prefix, urls } = await mintSnapshotUpload(storage, OWNER, "ws", ARCHIVED_AT);
  assert.equal(prefix, "archives/owner-1/ws/2026-08-05T12-30-00-000Z/");
  assert.equal(urls.length, Object.keys(SNAPSHOT_ARTIFACTS).length);
});

test("mintSnapshotDownloadUrl signs an in-scope key with the default TTL", async () => {
  const storage = new FakeStorage();
  const path = snapshotManifestPath(
    planSnapshotUpload(OWNER, "ws", ARCHIVED_AT).prefix,
  );
  const url = await mintSnapshotDownloadUrl(storage, path, OWNER);
  assert.equal(storage.downloadCalls[0].expiresIn, DEFAULT_DOWNLOAD_TTL_SECONDS);
  assert.ok(url.startsWith(`https://signed/download/${path}`));
});

test("mintSnapshotDownloadUrl refuses a cross-owner key without calling storage", async () => {
  const storage = new FakeStorage();
  const foreign = snapshotManifestPath(
    planSnapshotUpload("owner-2", "ws", ARCHIVED_AT).prefix,
  );
  await assert.rejects(() => mintSnapshotDownloadUrl(storage, foreign, OWNER));
  assert.equal(storage.downloadCalls.length, 0);
});
