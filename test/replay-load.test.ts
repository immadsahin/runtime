import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleReplay } from "@/lib/runtime/replay/load";
import type { SnapshotStorage } from "@/lib/runtime/storage/snapshots";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";

const OWNER = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";
const PREFIX = `archives/${OWNER}/${WORKSPACE}/2026-08-06T00-00-00-000Z/`;

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
  checksums: {},
  sizes: {},
  startedAt: "2026-08-05T23:00:00Z",
  archivedAt: "2026-08-06T00:00:00Z",
  lastCommit: null,
  lastMessage: null,
  tokenUsage: {},
  changedFiles: 1,
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

const artifacts: Record<string, string> = {
  [`${PREFIX}session.cast`]: '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]',
  [`${PREFIX}conversation.jsonl`]:
    '{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  [`${PREFIX}uncommitted.patch`]: "diff --git a/x b/x\n+world\n",
  [`${PREFIX}summary.json`]: JSON.stringify({
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

// Fake storage: signs a URL as "signed:<path>"; only in-scope paths are allowed
// (mirrors the real owner-scope guard).
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

test("assembleReplay reads every artifact via signed URLs and parses them", async () => {
  const { storage, signed } = fakeStorage();
  const fetchText = async (url: string) => {
    const path = url.replace(/^signed:/, "");
    if (!(path in artifacts)) throw new Error(`unexpected fetch: ${path}`);
    return artifacts[path];
  };

  const payload = await assembleReplay({ snapshot, ownerId: OWNER, storage, fetchText });

  // All four manifest-pointed artifacts were signed (bundle is NOT fetched).
  assert.deepEqual(signed.sort(), [
    `${PREFIX}conversation.jsonl`,
    `${PREFIX}session.cast`,
    `${PREFIX}summary.json`,
    `${PREFIX}uncommitted.patch`,
  ]);

  assert.equal(payload.manifest.sessionId, "sess-1");
  assert.deepEqual(payload.cast.frames, [{ time: 0.1, data: "hello" }]);
  assert.equal(payload.events.length, 1);
  assert.equal((payload.events[0] as { uuid: string }).uuid, "u1");
  assert.match(payload.patch, /\+world/);
  assert.equal(payload.summary?.commitCount, 2);
  assert.equal(payload.summary?.filesTouched.length, 1);
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
        fetchText: async () => "",
      }),
    /outside owner/,
  );
});

test("assembleReplay yields a null summary when summary.json is malformed", async () => {
  const { storage } = fakeStorage();
  const fetchText = async (url: string) => {
    const path = url.replace(/^signed:/, "");
    if (path.endsWith("summary.json")) return "not json";
    return artifacts[path] ?? "";
  };
  const payload = await assembleReplay({ snapshot, ownerId: OWNER, storage, fetchText });
  assert.equal(payload.summary, null);
});
