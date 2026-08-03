import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { optionalEnv } from "@/lib/env";
import {
  probeRuntimeDatabase,
  RUNTIME_TABLES,
} from "@/lib/supabase/probe";

export const dynamic = "force-dynamic";

type Check = {
  label: string;
  state: "ok" | "missing" | "pending";
  detail: string;
};

async function runChecks(): Promise<Check[]> {
  const supabaseConfigured =
    Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_URL")) &&
    Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

  let migrated = false;
  let migrationDetail = "Supabase keys are not configured yet.";

  if (supabaseConfigured) {
    const tableStatus = await probeRuntimeDatabase();
    const missing = RUNTIME_TABLES.filter(
      (table) => tableStatus[table] === "missing",
    );
    const unreachable = RUNTIME_TABLES.filter(
      (table) => tableStatus[table] === "unreachable",
    );
    migrated = missing.length === 0 && unreachable.length === 0;
    migrationDetail = migrated
      ? "projects, workspaces and jobs are all reachable."
      : missing.length > 0
        ? `Missing tables: ${missing.join(", ")}. Run supabase/migrations/*.sql in the SQL editor.`
        : "Could not reach the database. Check the Supabase URL and publishable key.";
  }

  return [
    {
      label: "Supabase keys",
      state: supabaseConfigured ? "ok" : "missing",
      detail: supabaseConfigured
        ? "URL and publishable key are set."
        : "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    },
    {
      label: "Runtime owner",
      state: optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN") ? "ok" : "missing",
      detail: optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN")
        ? "The GitHub owner allowlist is configured."
        : "Set RUNTIME_OWNER_GITHUB_LOGIN or every GitHub sign-in will be rejected.",
    },
    {
      label: "Database migrated",
      state: migrated ? "ok" : supabaseConfigured ? "missing" : "pending",
      detail: migrationDetail,
    },
    {
      label: "Service role key",
      state: optionalEnv("SUPABASE_SERVICE_ROLE_KEY") ? "ok" : "missing",
      detail: optionalEnv("SUPABASE_SERVICE_ROLE_KEY")
        ? "Server-side writes can bypass RLS when needed."
        : "Set SUPABASE_SERVICE_ROLE_KEY for background job bookkeeping.",
    },
    {
      label: "GitHub OAuth provider",
      state: "pending",
      detail:
        "Enable GitHub under Authentication -> Providers in Supabase, then add <app-origin>/auth/callback to Redirect URLs. Cannot be verified from the server.",
    },
    {
      label: "GitHub PAT",
      state: optionalEnv("GITHUB_PAT") ? "ok" : "missing",
      detail: optionalEnv("GITHUB_PAT")
        ? "Clones, pushes and PRs will be authored by your account."
        : "Set GITHUB_PAT so commits and pull requests come from you, not a bot.",
    },
    {
      label: "Claude Code credentials",
      state:
        optionalEnv("ANTHROPIC_API_KEY") ||
        optionalEnv("CLAUDE_CODE_OAUTH_TOKEN")
          ? "ok"
          : "missing",
      detail: "Needed from M6, when jobs actually run.",
    },
    {
      label: "Modal credentials",
      state:
        optionalEnv("MODAL_TOKEN_ID") && optionalEnv("MODAL_TOKEN_SECRET")
          ? "ok"
          : "missing",
      detail:
        "Set both values, then use RUNTIME_PROVIDER=modal to create Volume-backed cloud workspaces.",
    },
  ];
}

const icon = {
  ok: <CheckCircle2 className="text-success size-4 shrink-0" />,
  missing: <CircleAlert className="text-destructive size-4 shrink-0" />,
  pending: <CircleDashed className="text-muted-foreground size-4 shrink-0" />,
};

export default async function SetupPage() {
  const checks = await runChecks();
  const ready = checks.filter((c) => c.state === "ok").length;

  return (
    <AppShell active="/setup">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
        <p className="text-muted-foreground text-sm">
          Live configuration status. {ready} of {checks.length} checks passing.
        </p>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Environment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {checks.map((c) => (
            <div key={c.label} className="flex items-start gap-3 text-sm">
              {icon[c.state]}
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.label}</span>
                  {c.state === "pending" && (
                    <Badge
                      variant="outline"
                      className="text-muted-foreground font-mono text-[10px]"
                    >
                      manual
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">{c.detail}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </AppShell>
  );
}
