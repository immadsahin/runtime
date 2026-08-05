import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SNAPSHOT_BUCKET,
  mintSnapshotDownloadUrl,
  mintSnapshotUpload,
  type SnapshotStorage,
} from "@/lib/runtime/storage/snapshots";

/**
 * Real upload -> download round-trip against the actual private bucket. Gated on
 * SUPABASE_* env so `pnpm check` stays hermetic (the repo's no-real-services
 * convention); run manually for the M4 acceptance criterion, after the bucket
 * migration has applied. Uses @supabase/supabase-js directly (no Next) and
 * exercises the same mint helpers the flows use.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const skip = url && serviceKey ? false : "requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY";

test("snapshot storage signed-URL round-trip (real bucket)", { skip }, async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url as string, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = client.storage.from(SNAPSHOT_BUCKET);

  const storage: SnapshotStorage = {
    async createSignedUploadUrl(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) throw new Error(error?.message ?? "no upload URL");
      return data;
    },
    async createSignedDownloadUrl(path, expiresIn) {
      const { data, error } = await bucket.createSignedUrl(path, expiresIn);
      if (error || !data) throw new Error(error?.message ?? "no download URL");
      return data;
    },
  };

  const owner = "00000000-0000-0000-0000-000000000000";
  const workspaceId = "roundtrip-ws";
  const archivedAt = new Date().toISOString();
  const payload = `manifest-probe-${archivedAt}`;

  const { urls } = await mintSnapshotUpload(storage, owner, workspaceId, archivedAt);
  const manifest = urls.find((u) => u.artifact === "manifest");
  assert.ok(manifest, "expected a manifest upload target");

  try {
    const up = await bucket.uploadToSignedUrl(manifest.path, manifest.token, payload, {
      contentType: "application/json",
    });
    assert.equal(up.error, null, `upload failed: ${up.error?.message}`);

    const downloadUrl = await mintSnapshotDownloadUrl(storage, manifest.path, owner);
    const res = await fetch(downloadUrl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), payload);
  } finally {
    await bucket.remove([manifest.path]);
  }
});
