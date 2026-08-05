/**
 * The Workspace Snapshot manifest — the contract.
 *
 * A Snapshot is a first-class, immutable object addressed ENTIRELY through its
 * manifest. Every consumer (Replay, Restore, Mission, analytics) reads
 * `manifest.json` and follows its pointers; nothing enumerates a storage prefix.
 * This keeps features decoupled from storage layout.
 *
 * Invariants encoded here:
 * - The manifest is POINTER-ONLY. It carries relative artifact filenames,
 *   checksums, sizes, counts, and small scalars — never blobs. Large payloads
 *   (conversation, cast, tree, the Summary's `filesTouched`) are separate
 *   storage artifacts, referenced by filename.
 * - The Tree is an INTERFACE, not a format: `tree.kind` declares the impl and
 *   Restore dispatches on it. v0 ships `git-bundle+patch`; adding OCI/ZFS/etc.
 *   later is purely additive (a new member of the discriminated union).
 *
 * This zod schema is the single source of truth for the manifest shape; the
 * TypeScript type is inferred from it (never hand-duplicated).
 */
import { z } from "zod";

/**
 * The named artifacts a Snapshot is composed of. This table is the ONE place
 * artifact filenames are defined; the storage path builder and any consumer
 * import from here rather than re-spelling the names (DRY across the codebase,
 * and — since Next mints the upload URLs — the Go agent never needs the scheme,
 * only its own local cast filename).
 */
export const SNAPSHOT_ARTIFACTS = {
  conversation: "conversation.jsonl",
  cast: "session.cast",
  bundle: "worktree.bundle",
  patch: "uncommitted.patch",
  summary: "summary.json",
  manifest: "manifest.json",
} as const;

export type SnapshotArtifact = keyof typeof SNAPSHOT_ARTIFACTS;

/** sha256 digest, formatted `sha256:<hex>` (matches the manifest's own notation). */
const Sha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected a 'sha256:<hex>' digest");

/**
 * The filesystem capture, behind an interface. v0 is a git bundle (committed
 * history) plus a patch of the uncommitted working tree. Discriminated on
 * `kind` so Restore dispatches on the impl and future kinds are additive.
 */
export const SnapshotTree = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("git-bundle+patch"),
      bundle: z.literal(SNAPSHOT_ARTIFACTS.bundle),
      patch: z.literal(SNAPSHOT_ARTIFACTS.patch),
    })
    .strict(),
]);
export type SnapshotTree = z.infer<typeof SnapshotTree>;

/**
 * Aggregate token usage snapshotted at archive. A record of numbers (matching
 * the design's `{ "...": 0 }`) rather than the live `usage` event shape, since
 * this is a rollup, not a protocol frame.
 */
const ManifestTokenUsage = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

export const SnapshotManifest = z
  .object({
    /** Contract version. Bump only on a breaking manifest change. */
    version: z.literal(1),

    workspaceId: z.string().min(1),
    runtimeVersion: z.string().min(1),
    claudeVersion: z.string().min(1),

    /**
     * Claude session id for `claude --continue` on Restore. Nullable: a
     * workspace may be archived before Claude ever produced a session. Restore
     * verification enforces presence before booting Claude.
     */
    sessionId: z.string().min(1).nullable(),

    // Pointers — relative artifact filenames (see SNAPSHOT_ARTIFACTS).
    conversation: z.literal(SNAPSHOT_ARTIFACTS.conversation),
    cast: z.literal(SNAPSHOT_ARTIFACTS.cast),
    tree: SnapshotTree,
    summary: z.literal(SNAPSHOT_ARTIFACTS.summary),

    // Integrity — keyed by artifact filename.
    checksums: z.record(z.string(), Sha256),
    sizes: z.record(z.string(), z.number().int().nonnegative()),

    startedAt: z.string().min(1),
    archivedAt: z.string().min(1),

    /** Last committed sha; null when the worktree has no commits. */
    lastCommit: z.string().nullable(),
    /** Last assistant message (preview); null when there was none. */
    lastMessage: z.string().nullable(),
    tokenUsage: ManifestTokenUsage,
    /** COUNT of changed files. The file LIST lives in the Summary artifact. */
    changedFiles: z.number().int().nonnegative(),
  })
  .strict();

export type SnapshotManifest = z.infer<typeof SnapshotManifest>;

/** Parse-or-throw at a trust boundary (e.g. after reading manifest.json). */
export function parseManifest(value: unknown): SnapshotManifest {
  return SnapshotManifest.parse(value);
}
