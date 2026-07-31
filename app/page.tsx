import { redirect } from "next/navigation";
import { CircleDashed } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwnerSafe } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

const milestones = [
  { id: "M0", label: "App skeleton, Preview + setup scripts", done: true },
  { id: "M1", label: "Supabase schema: projects, workspaces, jobs" },
  { id: "M2", label: "GitHub sign-in and repository sync" },
  { id: "M3", label: "RuntimeProvider contract + local provider" },
  { id: "M4", label: "Modal provider: create workspace" },
  { id: "M5", label: "Resume, suspend, destroy" },
  { id: "M6", label: "Run Claude Code as a detached job" },
  { id: "M7", label: "Stream terminal logs" },
  { id: "M8", label: "Review changed files and diffs" },
  { id: "M9", label: "Create pull requests" },
  { id: "M10", label: "Linear issues attached to projects" },
];

export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  if (!(await getOwnerSafe())) redirect("/signin");

  return (
    <AppShell active="/">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Runtime</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Personal cloud environment for running Claude Code. The browser is
          only the control plane — every workspace, job, and commit executes
          inside a persistent cloud runtime.
        </p>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Build progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {milestones.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
            >
              {m.done ? (
                <Badge className="bg-success/15 text-success border-success/30 font-mono text-[11px]">
                  done
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-muted-foreground font-mono text-[11px]"
                >
                  <CircleDashed className="mr-1 size-3" />
                  todo
                </Badge>
              )}
              <span className="text-muted-foreground font-mono text-xs">
                {m.id}
              </span>
              <span className={m.done ? "" : "text-muted-foreground"}>
                {m.label}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </AppShell>
  );
}
