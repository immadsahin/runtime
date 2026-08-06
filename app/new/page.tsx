import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjects } from "@/lib/db/repositories";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  if (!(await getOwnerSafe())) redirect("/signin?next=/new");

  let projects: Project[] = [];
  try {
    projects = await listProjects();
  } catch (error) {
    console.error("Could not load repositories", error);
  }

  return (
    <AppShell immersive>
      <NewSessionCreator projects={projects} />
    </AppShell>
  );
}
