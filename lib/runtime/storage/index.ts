/**
 * Snapshot object-storage plumbing: private bucket + signed-URL helpers. The
 * archive/replay/restore flows that call these are built on top of M3 and live
 * elsewhere.
 */
export {
  SNAPSHOT_BUCKET,
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  planSnapshotUpload,
  isWithinOwnerScope,
  assertWithinOwnerScope,
  mintSnapshotUploadUrls,
  mintSnapshotUpload,
  mintSnapshotDownloadUrl,
  snapshotManifestPath,
  type SnapshotStorage,
  type SnapshotUploadTarget,
  type SnapshotUploadPlan,
  type SnapshotUploadUrl,
} from "@/lib/runtime/storage/snapshots";
export { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
