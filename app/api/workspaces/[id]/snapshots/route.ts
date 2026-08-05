import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace, listWorkspaceSnapshots } from "@/lib/db/repositories";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** A workspace's Snapshots, newest first — the Replay picker's list. */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const snapshots = await listWorkspaceSnapshots(workspace.id);
  return NextResponse.json({ snapshots });
}
