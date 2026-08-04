"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Job, JobAgent, JobStatus } from "@/lib/runtime/types";

const MAX_LOG_CHARS = 200_000;

const statusVariant: Record<JobStatus, "default" | "secondary" | "outline" | "destructive"> = {
  queued: "secondary",
  running: "default",
  succeeded: "outline",
  failed: "destructive",
  cancelled: "outline",
};

function isActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

export function WorkspaceJobPanel({
  workspaceId,
  jobs,
  canRun,
}: {
  workspaceId: string;
  jobs: Job[];
  canRun: boolean;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState<JobAgent>("claude");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Keyed by job id so switching jobs shows a fresh log without a synchronous
  // reset inside the effect (which the React Compiler lint disallows).
  const [log, setLog] = useState<{ jobId: string; text: string }>({ jobId: "", text: "" });

  const activeJob = jobs.find(isActive) ?? null;
  const activeJobId = activeJob?.id ?? null;
  const currentLog = activeJobId && log.jobId === activeJobId ? log.text : "";

  // Stream the active job's log for as long as one is running. Re-runs when the
  // active job changes; the cleanup aborts the previous stream.
  useEffect(() => {
    if (!activeJobId) return;
    const controller = new AbortController();
    void streamJobLog(workspaceId, activeJobId, controller.signal, {
      onLog: (text) =>
        setLog((current) => ({
          jobId: activeJobId,
          text: (current.jobId === activeJobId ? current.text + text : text).slice(-MAX_LOG_CHARS),
        })),
      onDone: () => router.refresh(),
      onError: (text) => setMessage(text),
    });
    return () => controller.abort();
  }, [workspaceId, activeJobId, router]);

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const task = prompt.trim();
      if (!task || submitting) return;
      setSubmitting(true);
      setMessage(null);
      void (async () => {
        try {
          const response = await fetch(`/api/workspaces/${workspaceId}/jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent, prompt: task }),
          });
          const result = (await response.json().catch(() => ({}))) as {
            job?: { id: string };
            error?: string;
          };
          if (!response.ok || !result.job) {
            setMessage(result.error ?? "Could not start Claude Code. Please try again.");
            return;
          }
          setPrompt("");
          // Re-render the server component so the new running job (and this
          // panel's streaming effect) picks it up.
          router.refresh();
        } catch {
          setMessage("Could not reach Runtime. Please try again.");
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [agent, prompt, submitting, workspaceId, router],
  );

  const disabled = !canRun || Boolean(activeJob) || submitting;

  return (
    <div className="space-y-4">
      <form className="space-y-2" onSubmit={submit}>
        <label className="text-sm font-medium" htmlFor="job-agent">Coding agent</label>
        <select
          aria-label="Coding agent"
          className="border-input bg-background h-9 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          id="job-agent"
          onChange={(event) => setAgent(event.target.value as JobAgent)}
          value={agent}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <Textarea
          aria-label={`Task for ${agent === "claude" ? "Claude Code" : "Codex"}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={
            canRun
              ? `Describe a task for ${agent === "claude" ? "Claude Code" : "Codex"} to run in this workspace…`
              : "The workspace must be ready before a coding agent can run."
          }
          disabled={disabled}
          maxLength={20_000}
          rows={3}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={disabled || prompt.trim().length === 0} size="sm" type="submit">
            {submitting ? <LoaderCircle className="animate-spin" /> : <Play />}
            {submitting ? "Starting" : `Run ${agent === "claude" ? "Claude Code" : "Codex"}`}
          </Button>
          {activeJob && (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <LoaderCircle className="size-3.5 animate-spin" />
              A job is running. Only one job runs at a time.
            </span>
          )}
          {message && (
            <p aria-live="polite" className="text-destructive text-xs">
              {message}
            </p>
          )}
        </div>
      </form>

      {activeJob && currentLog && (
        <pre className="bg-muted/50 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
          {currentLog}
        </pre>
      )}

      <JobHistory jobs={jobs} />
    </div>
  );
}

function JobHistory({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">No coding-agent jobs have run yet.</p>
    );
  }
  return (
    <ul className="space-y-2">
      {jobs.map((job) => (
        <li className="rounded-md border px-3 py-2 text-sm" key={job.id}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="font-mono capitalize">{job.agent}</Badge>
              <Badge variant={statusVariant[job.status]} className="font-mono capitalize">
                {job.status}
              </Badge>
            </div>
            <span className="text-muted-foreground text-xs" suppressHydrationWarning>
              {formatWhen(job.finishedAt ?? job.startedAt ?? job.createdAt)}
              {typeof job.costUsd === "number" ? ` · $${job.costUsd.toFixed(2)}` : ""}
            </span>
          </div>
          <p className="mt-1.5 line-clamp-2 break-words">{job.prompt}</p>
        </li>
      ))}
    </ul>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

type StreamHandlers = {
  onLog: (text: string) => void;
  onDone: (status: string) => void;
  onError: (message: string) => void;
};

/**
 * Consume the SSE log stream over `fetch` (not `EventSource`) so reconnects can
 * resume from a byte offset and the stream aborts cleanly on unmount.
 */
async function streamJobLog(
  workspaceId: string,
  jobId: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  let offset = 0;
  while (!signal.aborted) {
    let sawDone = false;
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/jobs/${jobId}/logs?offset=${offset}`,
        { signal, headers: { Accept: "text/event-stream" } },
      );
      if (!response.ok || !response.body) throw new Error("stream unavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseEvent(rawEvent);
          if (parsed?.event === "log") {
            const data = parsed.data as { offset?: number; text?: string };
            if (typeof data.offset === "number") offset = data.offset;
            if (typeof data.text === "string") handlers.onLog(data.text);
          } else if (parsed?.event === "done") {
            sawDone = true;
            handlers.onDone(String((parsed.data as { status?: string }).status ?? ""));
          } else if (parsed?.event === "error") {
            handlers.onError(
              String((parsed.data as { message?: string }).message ?? "Log stream interrupted."),
            );
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    if (sawDone || signal.aborted) return;
    // Transient drop (proxy timeout, brief network loss): reconnect from offset.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function parseEvent(raw: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}
