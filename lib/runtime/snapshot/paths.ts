/**
 * The Snapshot storage path scheme — defined ONCE, here, and consumed by the
 * storage signed-URL minter (and anything else that needs an object key). The
 * manifest never encodes these paths (it holds relative filenames only); the
 * address of a Snapshot is its prefix, recorded on the DB row as `storage_path`.
 */
import {
  SNAPSHOT_ARTIFACTS,
  type SnapshotArtifact,
} from "@/lib/runtime/snapshot/manifest";

/**
 * Object-key-safe rendering of an ISO timestamp for use as a path segment.
 * The canonical timestamp is always `manifest.archivedAt`; this is a lossy,
 * human-readable, lexicographically-sortable label (colons/dots — awkward in
 * URLs and some storage backends — become dashes).
 */
export function archivedAtSegment(archivedAt: string): string {
  return archivedAt.replace(/[:.]/g, "-");
}

/**
 * The prefix all of a Snapshot's artifacts live under, within the snapshots
 * bucket. Owner-scoped first so RLS/path policies and per-owner listing align:
 *   archives/{owner_id}/{workspace_id}/{archivedAtSegment}/
 */
export function snapshotPrefix(
  ownerId: string,
  workspaceId: string,
  archivedAt: string,
): string {
  return `archives/${ownerId}/${workspaceId}/${archivedAtSegment(archivedAt)}/`;
}

/** Full object key for one artifact under a Snapshot prefix. */
export function snapshotArtifactPath(
  prefix: string,
  artifact: SnapshotArtifact,
): string {
  return `${prefix}${SNAPSHOT_ARTIFACTS[artifact]}`;
}

/** Every artifact's object key under a prefix, keyed by artifact name. */
export function snapshotArtifactPaths(
  prefix: string,
): Record<SnapshotArtifact, string> {
  const out = {} as Record<SnapshotArtifact, string>;
  for (const artifact of Object.keys(SNAPSHOT_ARTIFACTS) as SnapshotArtifact[]) {
    out[artifact] = snapshotArtifactPath(prefix, artifact);
  }
  return out;
}
