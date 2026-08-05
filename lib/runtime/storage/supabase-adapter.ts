/**
 * The concrete {@link SnapshotStorage} backed by Supabase Storage.
 *
 * Kept separate from `snapshots.ts` so the pure logic there stays free of the
 * Next/Supabase import graph (and thus unit-testable without env or network).
 * Uses the service-role client: minting signed URLs on the owner's behalf is a
 * trusted server-side operation, and the URLs themselves are the capability the
 * agent receives — never the bucket credentials.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";

import {
  SNAPSHOT_BUCKET,
  type SnapshotStorage,
} from "@/lib/runtime/storage/snapshots";

export function supabaseSnapshotStorage(): SnapshotStorage {
  const bucket = createSupabaseAdminClient().storage.from(SNAPSHOT_BUCKET);
  return {
    async createSignedUploadUrl(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) {
        throw new Error(
          `failed to mint upload URL for "${path}": ${error?.message ?? "no data"}`,
        );
      }
      return data;
    },
    async createSignedDownloadUrl(path, expiresIn) {
      const { data, error } = await bucket.createSignedUrl(path, expiresIn);
      if (error || !data) {
        throw new Error(
          `failed to mint download URL for "${path}": ${error?.message ?? "no data"}`,
        );
      }
      return data;
    },
  };
}
