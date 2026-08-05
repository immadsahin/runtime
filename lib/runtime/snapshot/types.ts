/**
 * Domain model for a persisted Workspace Snapshot (the `workspace_snapshots`
 * row), mirroring the db-layer convention in `lib/runtime/types.ts`: camelCase,
 * snake_case confined to the mapper.
 *
 * The `manifest` field REUSES the inferred `SnapshotManifest` type rather than
 * re-typing its fields — one schema, one shape. The DB row is a derived index;
 * the canonical manifest is the storage object it caches.
 */
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";

/**
 * Retention intent (mirrors the `archive_policy` enum). v0 only writes
 * `manual_only`; the field exists so we never implicitly commit to infinite
 * storage. `retentionDays` is required by the db only for `delete_after_n_days`.
 */
export type ArchivePolicy =
  | "keep_forever"
  | "delete_after_n_days"
  | "manual_only";

export type WorkspaceSnapshot = {
  id: string;
  workspaceId: string;
  /** Logical time the Snapshot was produced (mirrors manifest.archivedAt). */
  archivedAt: string;
  /** Storage prefix the artifacts live under; manifest is at `${storagePath}manifest.json`. */
  storagePath: string;
  /** Cached, derived copy of the canonical manifest (parsed at the boundary). */
  manifest: SnapshotManifest;
  policy: ArchivePolicy;
  retentionDays: number | null;
  createdAt: string;
  updatedAt: string;
};
