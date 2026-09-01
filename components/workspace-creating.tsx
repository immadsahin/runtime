"use client";

import { Check, GitBranch, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Full-screen provisioning progress shown while a workspace is being created.
 * Cloud provisioning (sandbox → agent → clone → session) takes tens of seconds,
 * so instead of a bare spinner we walk a staged checklist on a time estimate.
 * The final stage HOLDS (never auto-completes) until the create request resolves
 * and the caller navigates away — we never claim "done" before the box is ready.
 */

/** Ordered provisioning stages with the elapsed second each becomes active. */
const STAGES = [
  { label: "Preparing", at: 0 },
  { label: "Provisioning sandbox", at: 3 },
  { label: "Installing agent", at: 12 },
  { label: "Cloning repository", at: 28 },
  { label: "Starting session", at: 38 },
  { label: "Finalizing setup", at: 46 },
] as const;

const ESTIMATE_SECONDS = 45;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function WorkspaceCreating({
  projectName,
  branch,
}: {
  projectName: string;
  branch: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, []);

  // The active stage is the last one whose threshold we've passed, capped at the
  // final stage so we hold there until provisioning actually completes.
  let active = 0;
  for (let i = 0; i < STAGES.length; i += 1) {
    if (elapsed >= STAGES[i].at) active = i;
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />

        <div className="space-y-1">
          <h1 className="text-foreground text-lg font-medium tracking-tight">
            Creating workspace
          </h1>
          <p className="text-muted-foreground flex items-center gap-1.5 font-mono text-sm">
            <GitBranch className="size-3.5" />
            {projectName} · {branch}
          </p>
        </div>

        <ul className="space-y-2.5">
          {STAGES.map((stage, i) => {
            const done = i < active;
            const current = i === active;
            return (
              <li key={stage.label} className="flex items-center gap-2.5">
                <span className="grid size-4 place-items-center">
                  {done ? (
                    <span className="bg-foreground grid size-4 place-items-center rounded-full">
                      <Check className="text-background size-2.5" strokeWidth={3} />
                    </span>
                  ) : current ? (
                    <span className="border-foreground grid size-4 place-items-center rounded-full border">
                      <span className="bg-foreground size-1.5 rounded-full" />
                    </span>
                  ) : (
                    <span className="bg-muted-foreground/40 size-1.5 rounded-full" />
                  )}
                </span>
                <span
                  className={
                    done || current
                      ? "text-foreground text-sm"
                      : "text-muted-foreground/60 text-sm"
                  }
                >
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="text-muted-foreground flex items-center justify-between font-mono text-xs">
          <span>{clock(elapsed)}</span>
          <span>~{ESTIMATE_SECONDS}s typical</span>
        </div>
      </div>
    </div>
  );
}
