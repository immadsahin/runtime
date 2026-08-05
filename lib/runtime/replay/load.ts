/**
 * Assemble a Snapshot's Replay payload — the manifest plus its parsed artifacts
 * — reading ONLY from object storage (M4 invariant #2: Replay never requires a
 * Runtime Computer). The manifest is the entry point: we follow its pointers to
 * the cast, conversation, patch, and summary and never enumerate the bucket.
 *
 * Kept storage-agnostic (a {@link SnapshotStorage} + a text fetcher are injected)
 * so it unit-tests without Supabase or the network.
 */
import { WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { parseCast, type Cast } from "@/lib/runtime/replay/cast";
import { parseConversation } from "@/lib/runtime/replay/conversation";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
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

/** Fetches text from a signed URL. Injected so tests avoid the network. */
export type TextFetcher = (url: string) => Promise<string>;

export async function assembleReplay(input: {
  snapshot: WorkspaceSnapshot;
  ownerId: string;
  storage: SnapshotStorage;
  fetchText: TextFetcher;
}): Promise<ReplayPayload> {
  const { snapshot, ownerId, storage, fetchText } = input;
  const { manifest, storagePath } = snapshot;

  // Manifest pointers -> object keys under the Snapshot's prefix. The manifest
  // holds relative filenames only; the prefix is the DB row's storage_path.
  const read = async (filename: string): Promise<string> => {
    const url = await mintSnapshotDownloadUrl(storage, `${storagePath}${filename}`, ownerId);
    return fetchText(url);
  };

  const [castText, conversationText, patch, summaryText] = await Promise.all([
    read(manifest.cast),
    read(manifest.conversation),
    read(manifest.tree.patch),
    read(manifest.summary),
  ]);

  const parsedSummary = WorkspaceSummary.safeParse(safeJson(summaryText));

  return {
    manifest,
    cast: parseCast(castText),
    events: parseConversation(conversationText),
    patch,
    summary: parsedSummary.success ? parsedSummary.data : null,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
