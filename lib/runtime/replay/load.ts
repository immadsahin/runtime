/**
 * Assemble a Snapshot's Replay payload — the manifest plus its parsed artifacts
 * — reading ONLY from object storage (M4 invariant #2: Replay never requires a
 * Runtime Computer). Two integrity rules make this the Snapshot's trust boundary:
 *
 *  1. The CANONICAL manifest is `manifest.json` in storage — the entry point —
 *     not the db row's cached copy; we fetch and `parseManifest` it, then follow
 *     its pointers. A cache/object divergence therefore can't mislead Replay.
 *  2. Every artifact is verified against the manifest's recorded size + SHA-256
 *     before it is parsed or returned; a corrupted or overwritten object fails
 *     loudly instead of being silently rendered.
 *
 * Kept storage-agnostic (a {@link SnapshotStorage} + a byte fetcher are injected)
 * so it unit-tests without Supabase or the network.
 */
import { createHash } from "node:crypto";

import { WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { parseCast, type Cast } from "@/lib/runtime/replay/cast";
import { parseConversation } from "@/lib/runtime/replay/conversation";
import {
  parseManifest,
  SNAPSHOT_ARTIFACTS,
  type SnapshotManifest,
} from "@/lib/runtime/snapshot/manifest";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";
import {
  mintSnapshotDownloadUrl,
  type SnapshotStorage,
} from "@/lib/runtime/storage/snapshots";

export type ReplayPayload = {
  manifest: SnapshotManifest;
  cast: Cast;
  events: AgentEvent[];
  patch: string;
  summary: WorkspaceSummary | null;
};

/** Fetches raw bytes from a signed URL. Injected so tests avoid the network. */
export type BytesFetcher = (url: string) => Promise<Uint8Array>;

export async function assembleReplay(input: {
  snapshot: WorkspaceSnapshot;
  ownerId: string;
  storage: SnapshotStorage;
  fetchBytes: BytesFetcher;
}): Promise<ReplayPayload> {
  const { snapshot, ownerId, storage, fetchBytes } = input;
  const { storagePath } = snapshot;

  const readBytes = async (filename: string): Promise<Uint8Array> => {
    const url = await mintSnapshotDownloadUrl(storage, `${storagePath}${filename}`, ownerId);
    return fetchBytes(url);
  };

  // The manifest is the contract; read the canonical object, not the db cache.
  const manifest = parseManifest(JSON.parse(decode(await readBytes(SNAPSHOT_ARTIFACTS.manifest))));

  // Fetch each pointed-at artifact and verify integrity BEFORE parsing.
  const readVerified = async (filename: string): Promise<Uint8Array> => {
    const bytes = await readBytes(filename);
    verifyIntegrity(filename, bytes, manifest);
    return bytes;
  };
  const [castBytes, conversationBytes, patchBytes, summaryBytes] = await Promise.all([
    readVerified(manifest.cast),
    readVerified(manifest.conversation),
    readVerified(manifest.tree.patch),
    readVerified(manifest.summary),
  ]);

  const parsedSummary = WorkspaceSummary.safeParse(safeJson(decode(summaryBytes)));

  return {
    manifest,
    cast: parseCast(decode(castBytes)),
    events: parseConversation(decode(conversationBytes)),
    patch: decode(patchBytes),
    summary: parsedSummary.success ? parsedSummary.data : null,
  };
}

/**
 * Enforce the manifest's integrity metadata for one artifact. Size and digest
 * are checked only when the manifest records them (a legacy/empty manifest with
 * no checksums simply isn't verifiable); when present, a mismatch throws.
 */
function verifyIntegrity(
  filename: string,
  bytes: Uint8Array,
  manifest: SnapshotManifest,
): void {
  const expectedSize = manifest.sizes[filename];
  if (expectedSize !== undefined && bytes.length !== expectedSize) {
    throw new Error(
      `Snapshot artifact "${filename}" size ${bytes.length} != manifest ${expectedSize}`,
    );
  }
  const expectedDigest = manifest.checksums[filename];
  if (expectedDigest !== undefined) {
    const actual = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedDigest) {
      throw new Error(`Snapshot artifact "${filename}" digest mismatch`);
    }
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
