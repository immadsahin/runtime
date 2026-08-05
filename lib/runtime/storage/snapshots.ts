/**
 * Snapshot object storage — signed-URL plumbing.
 *
 * A Snapshot's bytes live in a PRIVATE, owner-scoped Supabase Storage bucket.
 * The agent never holds bucket credentials: Next (trusted, server-side) mints
 * short-lived signed URLs and hands them over — signed UPLOAD URLs to push
 * artifacts at archive, signed DOWNLOAD URLs to read them for replay/restore.
 * This keeps large binaries off the control plane (M4 open decision #1).
 *
 * The pure logic here (upload plan, scope guards, mint fan-out) is decoupled
 * from the concrete Supabase client behind {@link SnapshotStorage} so it can be
 * unit-tested without network or Next; the real client lives in
 * `supabase-adapter.ts`.
 */
import {
  SNAPSHOT_ARTIFACTS,
  type SnapshotArtifact,
} from "@/lib/runtime/snapshot/manifest";
import {
  snapshotArtifactPaths,
  snapshotPrefix,
} from "@/lib/runtime/snapshot/paths";

/** Private bucket holding every Snapshot's artifacts. Created by migration. */
export const SNAPSHOT_BUCKET = "workspace-snapshots";

/** Default lifetime for a signed download URL (replay/restore reads). */
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 60 * 60;

/**
 * The narrow slice of Supabase Storage this module needs. Injecting it keeps the
 * logic testable and the Next/Supabase import graph out of the unit tests.
 */
export interface SnapshotStorage {
  createSignedUploadUrl(
    path: string,
  ): Promise<{ signedUrl: string; token: string; path: string }>;
  createSignedDownloadUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ signedUrl: string }>;
}

export type SnapshotUploadTarget = { artifact: SnapshotArtifact; path: string };
export type SnapshotUploadPlan = {
  prefix: string;
  targets: SnapshotUploadTarget[];
};
export type SnapshotUploadUrl = SnapshotUploadTarget & {
  signedUrl: string;
  token: string;
};

/**
 * Which object keys a Snapshot's artifacts map to under an owner-scoped prefix.
 * Pure — no network — so the path/scoping contract is unit-testable on its own.
 */
export function planSnapshotUpload(
  ownerId: string,
  workspaceId: string,
  archivedAt: string,
): SnapshotUploadPlan {
  const prefix = snapshotPrefix(ownerId, workspaceId, archivedAt);
  const paths = snapshotArtifactPaths(prefix);
  const targets = (Object.keys(paths) as SnapshotArtifact[]).map((artifact) => ({
    artifact,
    path: paths[artifact],
  }));
  return { prefix, targets };
}

/**
 * Whether an object key is confined to an owner's Snapshot namespace. Guards
 * against cross-owner access and path traversal on keys that originate outside
 * this module (e.g. a `storage_path` read back from the db).
 */
export function isWithinOwnerScope(path: string, ownerId: string): boolean {
  return (
    path.startsWith(`archives/${ownerId}/`) &&
    !path.split("/").includes("..")
  );
}

export function assertWithinOwnerScope(path: string, ownerId: string): void {
  if (!isWithinOwnerScope(path, ownerId)) {
    throw new Error(
      `refusing signed URL for "${path}": outside owner ${ownerId}'s Snapshot scope`,
    );
  }
}

/**
 * Mint one signed upload URL per artifact, concurrently (archive is rare, but a
 * single round-trip beats N serial ones). Order matches the plan's targets.
 */
export function mintSnapshotUploadUrls(
  storage: SnapshotStorage,
  plan: SnapshotUploadPlan,
): Promise<SnapshotUploadUrl[]> {
  return Promise.all(
    plan.targets.map(async ({ artifact, path }) => {
      const signed = await storage.createSignedUploadUrl(path);
      return { artifact, path: signed.path, signedUrl: signed.signedUrl, token: signed.token };
    }),
  );
}

/** Convenience: plan + mint the whole artifact set for one Snapshot. */
export async function mintSnapshotUpload(
  storage: SnapshotStorage,
  ownerId: string,
  workspaceId: string,
  archivedAt: string,
): Promise<{ prefix: string; urls: SnapshotUploadUrl[] }> {
  const plan = planSnapshotUpload(ownerId, workspaceId, archivedAt);
  const urls = await mintSnapshotUploadUrls(storage, plan);
  return { prefix: plan.prefix, urls };
}

/**
 * Mint a signed download URL for one artifact, after verifying the key is within
 * the owner's scope. Used by replay/restore to read Snapshot bytes.
 */
export async function mintSnapshotDownloadUrl(
  storage: SnapshotStorage,
  path: string,
  ownerId: string,
  expiresIn: number = DEFAULT_DOWNLOAD_TTL_SECONDS,
): Promise<string> {
  assertWithinOwnerScope(path, ownerId);
  const { signedUrl } = await storage.createSignedDownloadUrl(path, expiresIn);
  return signedUrl;
}

/** The manifest's object key under a Snapshot prefix (the entry point). */
export function snapshotManifestPath(prefix: string): string {
  return `${prefix}${SNAPSHOT_ARTIFACTS.manifest}`;
}
