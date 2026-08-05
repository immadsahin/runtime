import { notFound, redirect } from "next/navigation";

import { getOwnerSafe } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";

import { PtySpikeClient } from "./pty-spike-client";

export const dynamic = "force-dynamic";

/**
 * PHASE-1 spike route — proves the PTY transport end-to-end against a real
 * Daytona box. Not linked from any nav; not the Workspace Experience. Delete
 * (or fold in) once M3 Phase 5 assembles the real page.
 *
 * See docs/architecture/session-contract.md and the Phase 1 section of the
 * M3 spike report.
 */
export default async function PtySpikePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");
  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  return <PtySpikeClient workspaceId={workspace.id} branch={workspace.branch} />;
}
