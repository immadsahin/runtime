import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { assembleReplay } from "@/lib/runtime/replay/load";
import type { SnapshotStorage } from "@/lib/runtime/storage/snapshots";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";

const OWNER = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";
const PREFIX = `archives/${OWNER}/${WORKSPACE}/2026-08-06T00-00-00-000Z/`;

const artifactText: Record<string, string> = {
  "session.cast": '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]',
  "conversation.jsonl":
    '{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  "uncommitted.patch": "diff --git a/x b/x\n+world\n",
  "summary.json": JSON.stringify({
    state: "archived",
    startedAt: "2026-08-05T23:00:00Z",
    endedAt: "2026-08-06T00:00:00Z",
    duration: 3600,
    lastActivity: "2026-08-05T23:30:00Z",
    tokenUsage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    changedFiles: 1,
    filesTouched: ["x"],
    commitCount: 2,
    lastAssistantMessage: "done",
  }),
};

function digest(text: string): string {
  return "sha256:" + createHash("sha256").update(Buffer.from(text)).digest("hex");
}
function size(text: string): number {
  return Buffer.from(text).length;
}

const manifest: SnapshotManifest = {
  version: 1,
  workspaceId: WORKSPACE,
  runtimeVersion: "dev",
  claudeVersion: "claude-code-1.2.3",
  sessionId: "sess-1",
  conversation: "conversation.jsonl",
  cast: "session.cast",
  tree: { kind: "git-bundle+patch", bundle: "worktree.bundle", patch: "uncommitted.patch" },
  summary: "summary.json",
  checksums: Object.fromEntries(Object.entries(artifactText).map(([k, v]) => [k, digest(v)])),
  sizes: Object.fromEntries(Object.entries(artifactText).map(([k, v]) => [k, size(v)])),
  startedAt: "2026-08-05T23:00:00Z",
  archivedAt: "2026-08-06T00:00:00Z",
  lastCommit: null,
  lastMessage: null,
  tokenUsage: {},
  changedFiles: 1,
};

// The canonical manifest.json object the loader reads first.
const objects: Record<string, string> = {
  ...artifactText,
  "manifest.json": JSON.stringify(manifest),
};

const snapshot: WorkspaceSnapshot = {
  id: "snap-1",
  workspaceId: WORKSPACE,
  archivedAt: "2026-08-06T00:00:00Z",
  storagePath: PREFIX,
  manifest,
  policy: "manual_only",
  retentionDays: null,
  createdAt: "2026-08-06T00:00:01Z",
  updatedAt: "2026-08-06T00:00:01Z",
};

function fakeStorage(): { storage: SnapshotStorage; signed: string[] } {
  const signed: string[] = [];
  const storage: SnapshotStorage = {
    async createSignedUploadUrl(path) {
      return { signedUrl: `signed:${path}`, token: "t", path };
    },
    async createSignedDownloadUrl(path) {
      signed.push(path);
      return { signedUrl: `signed:${path}` };
    },
  };
  return { storage, signed };
}

function fetcherFrom(store: Record<string, string>) {
  return async (url: string): Promise<Uint8Array> => {
    const filename = url.replace(/^signed:/, "").slice(PREFIX.length);
    if (!(filename in store)) throw new Error(`unexpected fetch: ${filename}`);
    return new Uint8Array(Buffer.from(store[filename]));
  };
}

test("assembleReplay reads the canonical manifest + verifies and parses artifacts", async () => {
  const { storage } = fakeStorage();
  const payload = await assembleReplay({
    snapshot,
    ownerId: OWNER,
    storage,
    fetchBytes: fetcherFrom(objects),
  });

  assert.equal(payload.manifest.sessionId, "sess-1");
  assert.deepEqual(payload.cast.frames, [{ time: 0.1, data: "hello" }]);
  assert.equal(payload.events.length, 1);
  assert.equal((payload.events[0] as { uuid: string }).uuid, "u1");
  assert.match(payload.patch, /\+world/);
  assert.equal(payload.summary?.commitCount, 2);
});

test("assembleReplay rejects an artifact whose bytes don't match the manifest digest", async () => {
  const { storage } = fakeStorage();
  const tampered = { ...objects, "session.cast": objects["session.cast"] + "TAMPERED" };
  await assert.rejects(
    () =>
      assembleReplay({
        snapshot,
        ownerId: OWNER,
        storage,
        fetchBytes: fetcherFrom(tampered),
      }),
    /digest mismatch|size/,
  );
});

test("assembleReplay refuses a cross-owner storage path", async () => {
  const { storage } = fakeStorage();
  const crossOwner: WorkspaceSnapshot = {
    ...snapshot,
    storagePath: "archives/99999999-9999-9999-9999-999999999999/ws/seg/",
  };
  await assert.rejects(
    () =>
      assembleReplay({
        snapshot: crossOwner,
        ownerId: OWNER,
        storage,
        fetchBytes: async () => new Uint8Array(),
      }),
    /outside owner/,
  );
});

test("assembleReplay yields a null summary when summary.json is malformed", async () => {
  const { storage } = fakeStorage();
  // Re-checksum the malformed summary so integrity passes and parsing is exercised.
  const badSummary = "not json";
  const m2: SnapshotManifest = {
    ...manifest,
    checksums: { ...manifest.checksums, "summary.json": digest(badSummary) },
    sizes: { ...manifest.sizes, "summary.json": size(badSummary) },
  };
  const store = { ...objects, "summary.json": badSummary, "manifest.json": JSON.stringify(m2) };
  const payload = await assembleReplay({
    snapshot: { ...snapshot, manifest: m2 },
    ownerId: OWNER,
    storage,
    fetchBytes: fetcherFrom(store),
  });
  assert.equal(payload.summary, null);
});
