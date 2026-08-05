import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getWorkspace,
  getWorkspaceSnapshot,
  listWorkspaceSnapshots,
} from "@/lib/db/repositories";
import { assembleReplay } from "@/lib/runtime/replay/load";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Replay payload for one Snapshot: the manifest plus its parsed artifacts (cast,
 * conversation events, patch, summary), read ENTIRELY from object storage. No
 * Runtime Computer, no agent — Replay works even after the box is destroyed
 * (M4 invariant #2). `?snapshotId=` selects a Snapshot; default is the newest.
 */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const snapshotId = new URL(request.url).searchParams.get("snapshotId");
  let snapshot: WorkspaceSnapshot | null;
  if (snapshotId) {
    snapshot = await getWorkspaceSnapshot(snapshotId);
    if (snapshot && snapshot.workspaceId !== workspace.id) snapshot = null;
  } else {
    snapshot = (await listWorkspaceSnapshots(workspace.id))[0] ?? null;
  }
  if (!snapshot) {
    return NextResponse.json({ error: "No Snapshot found for this workspace." }, { status: 404 });
  }

  try {
    const payload = await assembleReplay({
      snapshot,
      ownerId: owner.id,
      storage: supabaseSnapshotStorage(),
      fetchText,
    });
    return NextResponse.json({ snapshotId: snapshot.id, ...payload });
  } catch (error) {
    console.error(`Replay: assemble failed for snapshot ${snapshot.id}`, error);
    return NextResponse.json(
      { error: "Could not load this Snapshot's replay." },
      { status: 502 },
    );
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch artifact failed (${response.status})`);
  }
  return response.text();
}
