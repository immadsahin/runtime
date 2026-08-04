import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getJob, getWorkspace, transitionJob } from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { makeRedactor } from "@/lib/runtime/redact";
import type { JobResult } from "@/lib/runtime/types";
import { claudeJobSecrets } from "@/lib/runtime/workspace-environment";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; jobId: string }> };

/**
 * Server-sent log stream for one job. Events:
 *   - `open`  { jobId, status }        once, on connect
 *   - `log`   { offset, text }         each redacted chunk; `offset` resumes
 *   - `done`  { status, exitCode }     job reached a terminal, reconciled state
 *   - `error` { message }              stream failed; client may reconnect
 *
 * Reconnect by passing `?offset=` (the last `log` offset) so no bytes repeat.
 */
export async function GET(request: Request, context: RouteContext) {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const { id, jobId } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  const job = await getJob(jobId);
  if (!job || job.workspaceId !== workspace.id) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const provider = getRuntimeProvider();
  if (provider.name !== workspace.provider) {
    return NextResponse.json(
      { error: `Configure the ${workspace.provider} provider to read this job.` },
      { status: 409 },
    );
  }
  if (!job.logPath) {
    return NextResponse.json({ error: "This job has not produced a log yet." }, { status: 409 });
  }

  const requested = Number(new URL(request.url).searchParams.get("offset") ?? "0");
  const fromOffset = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  const sandboxId = workspace.sandboxId ?? "";
  const redact = makeRedactor([...claudeJobSecrets(), optionalEnv("GITHUB_PAT")]);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const abort = new AbortController();
      let closed = false;
      let lastOffset = fromOffset;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        abort.abort();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime; nothing to do.
        }
      };

      request.signal.addEventListener("abort", close);
      // Comment pings defeat proxy buffering and surface dead connections.
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15_000);

      send("open", { jobId: job.id, status: job.status });

      const finish = async () => {
        const result = await readJobResult();
        if (result) {
          await persistTerminalState(job.id, result, lastOffset);
          send("done", { status: result.status, exitCode: result.exitCode });
        } else {
          // Compute vanished (e.g. suspended) without a result record.
          send("done", { status: "unknown", exitCode: null });
        }
        close();
      };

      const readJobResult = (): Promise<JobResult | null> =>
        provider
          .getJobResult({
            workspaceId: workspace.id,
            sandboxId,
            jobId: job.id,
            resultPath: job.resultPath,
          })
          .catch((error: unknown) => {
            console.error(`Job ${job.id} result could not be read`, error);
            return null;
          });

      // Poll for the provider-owned completion record independently of the log
      // tail, then let the tail flush before emitting `done`. The interval backs
      // off while the job is quiet (1s→8s) so a long, silent job does not hammer
      // the provider (Modal result reads are network calls); it resets to fast
      // polling whenever the tail delivers output.
      let quietPolls = 0;
      const pollDelay = () => Math.min(8_000, 1_000 * 2 ** Math.min(quietPolls, 3));
      void (async () => {
        while (!abort.signal.aborted) {
          if (await readJobResult()) {
            await sleep(500);
            break;
          }
          quietPolls += 1;
          await sleep(pollDelay());
        }
        if (!abort.signal.aborted) await finish();
      })();

      // Tail the log until the completion poller (or the client) closes us.
      void (async () => {
        try {
          for await (const chunk of provider.streamLogs({
            workspaceId: workspace.id,
            sandboxId,
            jobId: job.id,
            logPath: job.logPath,
            fromOffset,
            signal: abort.signal,
          })) {
            lastOffset = chunk.offset;
            quietPolls = 0; // output is flowing: keep completion polling responsive
            send("log", { offset: chunk.offset, text: redact(chunk.text) });
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            console.error(`Job ${job.id} log stream failed`, error);
            send("error", { message: "Log stream interrupted." });
            close();
          }
        }
      })();
    },
    cancel() {
      // The ReadableStream was cancelled (client went away); `request.signal`
      // fires `close`, which aborts the workers.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Move the job to its terminal state only while it is still queued or running,
 * so a reconnecting second stream cannot overwrite a recorded result.
 */
async function persistTerminalState(
  jobId: string,
  result: JobResult,
  logBytes: number,
): Promise<void> {
  try {
    await transitionJob({
      id: jobId,
      from: ["queued", "running"],
      patch: {
        status: result.status,
        exitCode: result.exitCode,
        finishedAt: result.finishedAt,
        logBytes,
        ...(result.sessionId !== undefined && { sessionId: result.sessionId }),
        ...(result.costUsd !== undefined && { costUsd: result.costUsd }),
      },
    });
  } catch (error) {
    console.error(`Job ${jobId} terminal state could not be saved`, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
