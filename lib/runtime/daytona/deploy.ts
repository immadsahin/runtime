/**
 * Agent deploy for the Daytona backend — decision 1A: upload-on-provision.
 *
 * The cross-compiled `runtime-agent` binary is gzipped, uploaded to the box,
 * gunzipped, made executable, and launched detached so it outlives the deploy
 * call (like a tmux server). Every stage is timed; the caller persists the
 * breakdown so a future "workspace creation feels slow" is a lookup, not a hunt.
 *
 * This module is intentionally free of the Daytona SDK: it talks to the box
 * through an injected {@link BoxIO}, so it is unit-testable (script builders,
 * timer) and reusable by both the provider and the real-box verify script.
 *
 * End state (deferred): once the agent stabilizes, bake it into
 * `runtime-computer-v2` and delete this whole path — see the pt2 spike report.
 */

import { gzipSync } from "node:zlib";

import type { ProvisionStage, StageTiming, ProvisionTimings } from "@/lib/runtime/types";

/** The single port the agent listens on; the preview URL is derived from it. */
export const AGENT_PORT = 8080;

/** On-box layout. Non-root `runtime` user, home `/home/runtime` (frozen image). */
export const AGENT_ROOT = "/home/runtime";
export const AGENT_BINARY_PATH = `${AGENT_ROOT}/runtime-agent`;
export const AGENT_GZ_PATH = `${AGENT_BINARY_PATH}.gz`;
export const AGENT_LOG_PATH = `${AGENT_ROOT}/runtime-agent.log`;

export type ExecResult = { stdout: string; exitCode: number };

/** How the deploy reaches one box. Provided by the SDK provider in production
 *  and by a thin shim in the verify script. */
export type BoxIO = {
  /** Run one shell command to completion; returns stdout + exit code. */
  exec: (command: string) => Promise<ExecResult>;
  /** Fire-and-forget a long-running command and return immediately. The daemon
   *  keeps running after this resolves — a plain synchronous exec would block
   *  until the process exits (Daytona's executeCommand waits on the daemon), so
   *  the launch MUST go through an async path. */
  launch: (command: string) => Promise<void>;
  /** Upload bytes to an absolute path on the box. */
  upload: (data: Buffer, remotePath: string) => Promise<void>;
};

/** Single-quote a value for safe inclusion in a `bash -lc` command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** gzip the agent for upload. Level 6 is the size/CPU sweet spot; the binary is
 *  incompressible-ish (already stripped) but still shrinks ~2×, which is the
 *  bottleneck the pt2 spike identified. */
export function compressAgent(binary: Buffer): Buffer {
  return gzipSync(binary, { level: 6 });
}

/** Unpack + make executable. Run synchronously so a gunzip/chmod failure
 *  surfaces as a non-zero exit *before* we try to launch. */
export function agentPrepScript(): string {
  return `gunzip -f ${AGENT_GZ_PATH} && chmod 755 ${AGENT_BINARY_PATH}`;
}

/**
 * Launch the agent, fully detached. `setsid … < /dev/null &` divorces it from
 * the launching session's process group so nothing kills it when the launch
 * call returns; stdout/stderr are captured to a log for diagnosis. This is run
 * through the async {@link BoxIO.launch} path — a synchronous exec would block
 * on the daemon forever.
 *
 * `RUNTIME_AGENT_SECRET` is the per-computer secret. Project secrets (Claude /
 * GitHub tokens) are delivered here at launch and live only in the agent's
 * process memory — the agent seeds each Claude session's env from its own
 * os.Environ(), so nothing is written to disk on the box.
 */
export function agentLaunchScript(
  secret: string,
  env: Record<string, string> = {},
): string {
  const extra = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const assignments =
    `RUNTIME_AGENT_SECRET=${shellQuote(secret)} ` +
    `RUNTIME_AGENT_ROOT=${AGENT_ROOT} PORT=${AGENT_PORT}` +
    (extra ? ` ${extra}` : "");
  return (
    `setsid env ${assignments} ` +
    `${AGENT_BINARY_PATH} > ${AGENT_LOG_PATH} 2>&1 < /dev/null &`
  );
}

/** Loopback health probe run on the box; proves the process bound its port. */
export function agentHealthProbe(): string {
  return `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${AGENT_PORT}/health || true`;
}

/**
 * Accumulates per-stage durations for one provision. Uses an injected clock so
 * tests are deterministic and the caller controls the time source (the workflow
 * sandbox forbids `Date.now()` in some contexts; the provider passes real time).
 */
export class ProvisionTimer {
  private readonly now: () => number;
  private readonly onStage?: (timing: StageTiming) => void;
  private readonly stages: StageTiming[] = [];
  private readonly startedAt: number;

  constructor(options: {
    now?: () => number;
    onStage?: (timing: StageTiming) => void;
  } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.onStage = options.onStage;
    this.startedAt = this.now();
  }

  /** Time one stage, recording (and reporting) its duration whether or not it
   *  throws — a failed stage's cost is still worth knowing. */
  async stage<T>(stage: ProvisionStage, fn: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      const timing = { stage, ms: Math.round(this.now() - start) };
      this.stages.push(timing);
      this.onStage?.(timing);
    }
  }

  timings(): ProvisionTimings {
    return {
      stages: [...this.stages],
      totalMs: Math.round(this.now() - this.startedAt),
    };
  }
}

export type WaitOptions = {
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Stage 1: push the gzipped agent to the box. The pt2 spike proved this is the
 *  provisioning bottleneck, which is why the payload is compressed first. */
export async function uploadAgent(io: BoxIO, binary: Buffer): Promise<void> {
  await io.upload(compressAgent(binary), AGENT_GZ_PATH);
}

/** Stage 2: unpack (synchronous, so failures throw) then launch the daemon
 *  detached via the async path, seeding its env with project secrets. */
export async function bootAgent(
  io: BoxIO,
  secret: string,
  env: Record<string, string> = {},
): Promise<void> {
  const prep = await io.exec(`bash -lc ${shellQuote(agentPrepScript())}`);
  if (prep.exitCode !== 0) {
    throw new Error(`agent prep failed (exit ${prep.exitCode}): ${prep.stdout.trim()}`);
  }
  await io.launch(`bash -lc ${shellQuote(agentLaunchScript(secret, env))}`);
}

/** Stage 3: poll loopback `/health` until the agent binds, or throw with the
 *  log tail — the single most useful artifact when a boot fails. Returns the
 *  log so callers can surface the "listening on :8080" line. */
export async function waitForAgentHealth(
  io: BoxIO,
  options: WaitOptions = {},
): Promise<{ logTail: string }> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < attempts; i += 1) {
    const probe = await io.exec(`bash -lc ${shellQuote(agentHealthProbe())}`);
    if (probe.stdout.trim() === "200") {
      const log = await io.exec(`cat ${AGENT_LOG_PATH} 2>&1 || true`);
      return { logTail: log.stdout.trim() };
    }
    await sleep(intervalMs);
  }

  const log = await io.exec(`cat ${AGENT_LOG_PATH} 2>&1 || true`);
  throw new Error(`agent did not bind :${AGENT_PORT}. log:\n${log.stdout.trim()}`);
}

/**
 * Convenience for callers that don't need per-stage timing (the verify script):
 * upload → boot → wait-for-health in one call. The provider composes the three
 * primitives itself so it can time each stage independently.
 */
export async function deployAgent(
  io: BoxIO,
  binary: Buffer,
  secret: string,
  options: WaitOptions & { env?: Record<string, string> } = {},
): Promise<{ logTail: string }> {
  await uploadAgent(io, binary);
  await bootAgent(io, secret, options.env);
  return waitForAgentHealth(io, options);
}
