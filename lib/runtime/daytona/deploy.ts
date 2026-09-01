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

// ---------------------------------------------------------------------------
// jcode engine deploy
//
// The jcode path runs the agent with RUNTIME_ENGINE=jcode against a
// `jcode api-bridge` on the box. It is root-parameterized because it runs on a
// default Daytona image (home /home/daytona), not the frozen /home/runtime
// snapshot — so it does NOT reuse the AGENT_* constants above. The recipe is the
// one validated on real Daytona (.context/provision-jcode-box.mjs).
// ---------------------------------------------------------------------------

/** Every box path the jcode deploy touches, derived from the box's home. */
export type JcodePaths = {
  runDir: string;
  apiSocket: string;
  daemonSocket: string;
  credDirs: string[];
  bridgeLog: string;
  agentBinary: string;
  agentGz: string;
  agentLog: string;
};

export function jcodePaths(root: string): JcodePaths {
  const runDir = `${root}/.jcode-run`;
  return {
    runDir,
    apiSocket: `${root}/jcode-api.sock`,
    daemonSocket: `${runDir}/daemon.sock`,
    // Both dirs: jcode reads creds from ~/.jcode (macOS) and ~/.config/jcode
    // (linux/XDG). Writing both makes the recipe host-agnostic.
    credDirs: [`${root}/.jcode`, `${root}/.config/jcode`],
    bridgeLog: `${root}/jcode-bridge.log`,
    agentBinary: `${root}/runtime-agent`,
    agentGz: `${root}/runtime-agent.gz`,
    agentLog: `${root}/runtime-agent.log`,
  };
}

/**
 * jcode version installed on each box. Defaults to `latest` (ride new releases),
 * with a known-good FALLBACK the deploy auto-reinstalls if `latest` fails to
 * come up healthy — so a bad release can't take provisioning down. Override
 * either via env.
 */
export const JCODE_SDK_VERSION = process.env.JCODE_SDK_VERSION || "latest";
export const JCODE_SDK_FALLBACK_VERSION =
  process.env.JCODE_SDK_FALLBACK_VERSION || "1.1.0";

/** Install a jcode version via npm on the box and echo the linux binary path. */
export function jcodeInstallScript(version: string = JCODE_SDK_VERSION): string {
  return (
    `cd /tmp && npm init -y -s >/dev/null 2>&1 && ` +
    `npm i @1jehuang/jcode-sdk@${version} >/tmp/jcode-npm.log 2>&1; ` +
    `ls /tmp/node_modules/@1jehuang/jcode-linux-*/bin/jcode`
  );
}

/**
 * Launch the api-bridge detached. VERIFIED ON DAYTONA: the detached env lacks
 * USER/XDG_RUNTIME_DIR, so jcode resolves its internal daemon socket to a broken
 * /tmp/jcode-user path and drops the connection on the first session op. Setting
 * a real user + a writable runtime dir AND pinning the internal --socket makes
 * the bridge and its spawned `serve` daemon agree. `-p claude` selects the
 * injected subscription credential.
 */
export function jcodeBridgeScript(jcodeBin: string, root: string): string {
  const p = jcodePaths(root);
  // bypassPermissions: the api-bridge can't relay approval prompts, so without
  // this jcode auto-BLOCKS risky commands ("blocked and cannot be confirmed").
  // The box is a disposable per-workspace sandbox, so bypassing is the correct
  // autonomy model (mirrors Claude's --permission-mode bypassPermissions).
  const env =
    `HOME=${root} USER=runtime XDG_RUNTIME_DIR=${p.runDir} TMPDIR=${p.runDir} ` +
    `JCODE_CLAUDE_SDK_PERMISSION_MODE=bypassPermissions ` +
    `JCODE_CLAUDE_CLI_PERMISSION_MODE=bypassPermissions`;
  return (
    `mkdir -p ${p.runDir} && chmod 700 ${p.runDir} && ` +
    `setsid env ${env} ${shellQuote(jcodeBin)} --socket ${p.daemonSocket} ` +
    `api-bridge --api-socket ${p.apiSocket} -p claude --no-update ` +
    `> ${p.bridgeLog} 2>&1 < /dev/null &`
  );
}

/** Launch the runtime-agent in jcode mode, detached, pointed at the bridge. */
export function jcodeAgentLaunchScript(root: string, secret: string): string {
  const p = jcodePaths(root);
  const assignments =
    `RUNTIME_AGENT_SECRET=${shellQuote(secret)} RUNTIME_AGENT_ROOT=${root} ` +
    `PORT=${AGENT_PORT} RUNTIME_ENGINE=jcode JCODE_API_SOCKET=${p.apiSocket} HOME=${root}`;
  return `setsid env ${assignments} ${p.agentBinary} > ${p.agentLog} 2>&1 < /dev/null &`;
}

/** Write the subscription credential into both cred dirs on the box. */
export async function injectJcodeCreds(
  io: BoxIO,
  root: string,
  authJson: Buffer,
  refreshJson?: Buffer,
): Promise<void> {
  for (const dir of jcodePaths(root).credDirs) {
    await io.exec(`mkdir -p ${dir}`);
    await io.upload(authJson, `${dir}/auth.json`);
    if (refreshJson) await io.upload(refreshJson, `${dir}/auth-refresh-state.json`);
    await io.exec(`chmod 600 ${dir}/auth.json`);
  }
}

/** Install jcode and return its binary path, or throw with the npm log. */
export async function installJcode(
  io: BoxIO,
  version: string = JCODE_SDK_VERSION,
): Promise<string> {
  const res = await io.exec(`bash -lc ${shellQuote(jcodeInstallScript(version))}`);
  const bin = res.stdout
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.endsWith("/bin/jcode"));
  if (!bin) throw new Error(`jcode install: binary not found. output:\n${res.stdout}`);
  return bin;
}

/** Launch the bridge and poll until its API socket exists, or throw with the log. */
export async function startJcodeBridge(
  io: BoxIO,
  jcodeBin: string,
  root: string,
  options: WaitOptions = {},
): Promise<void> {
  const p = jcodePaths(root);
  const attempts = options.attempts ?? 40;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  await io.launch(`bash -lc ${shellQuote(jcodeBridgeScript(jcodeBin, root))}`);
  for (let i = 0; i < attempts; i += 1) {
    const probe = await io.exec(`test -S ${p.apiSocket} && echo yes || echo no`);
    if (probe.stdout.trim() === "yes") return;
    await sleep(intervalMs);
  }
  const log = await io.exec(`cat ${p.bridgeLog} 2>&1 || true`);
  throw new Error(`jcode bridge socket ${p.apiSocket} never appeared. log:\n${log.stdout.trim()}`);
}

/** Upload + unpack + launch the agent in jcode mode (mirrors bootAgent). */
export async function bootJcodeAgent(
  io: BoxIO,
  binary: Buffer,
  secret: string,
  root: string,
): Promise<void> {
  const p = jcodePaths(root);
  await io.upload(compressAgent(binary), p.agentGz);
  const prep = await io.exec(
    `bash -lc ${shellQuote(`gunzip -f ${p.agentGz} && chmod 755 ${p.agentBinary}`)}`,
  );
  if (prep.exitCode !== 0) {
    throw new Error(`jcode agent prep failed (exit ${prep.exitCode}): ${prep.stdout.trim()}`);
  }
  await io.launch(`bash -lc ${shellQuote(jcodeAgentLaunchScript(root, secret))}`);
}

/** Poll the agent's loopback /health until it binds, or throw with the log. */
export async function waitForJcodeAgentHealth(
  io: BoxIO,
  root: string,
  options: WaitOptions = {},
): Promise<{ logTail: string }> {
  const p = jcodePaths(root);
  const attempts = options.attempts ?? 40;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < attempts; i += 1) {
    const probe = await io.exec(`bash -lc ${shellQuote(agentHealthProbe())}`);
    if (probe.stdout.trim() === "200") {
      return { logTail: (await io.exec(`cat ${p.agentLog} 2>&1 || true`)).stdout.trim() };
    }
    await sleep(intervalMs);
  }
  const log = await io.exec(`cat ${p.agentLog} 2>&1 || true`);
  throw new Error(`jcode agent did not bind :${AGENT_PORT}. log:\n${log.stdout.trim()}`);
}

/**
 * Full jcode deploy on one box: inject creds → install jcode → start bridge →
 * boot the agent → wait for health. Rides `latest` by default; if that version
 * fails to come up healthy (e.g. a breaking release), it resets and retries once
 * with the known-good fallback, so a bad `latest` can't take provisioning down.
 */
export async function deployJcode(
  io: BoxIO,
  binary: Buffer,
  secret: string,
  opts: WaitOptions & { root: string; authJson: Buffer; refreshJson?: Buffer },
): Promise<{ logTail: string }> {
  await injectJcodeCreds(io, opts.root, opts.authJson, opts.refreshJson);
  try {
    return await bootJcodeStack(io, binary, secret, opts.root, JCODE_SDK_VERSION, opts);
  } catch (err) {
    if (JCODE_SDK_VERSION === JCODE_SDK_FALLBACK_VERSION) throw err;
    console.warn(
      `jcode ${JCODE_SDK_VERSION} failed to come up; falling back to ${JCODE_SDK_FALLBACK_VERSION}. Cause: ${
        (err as Error).message
      }`,
    );
    await resetJcode(io, opts.root).catch(() => {});
    return bootJcodeStack(io, binary, secret, opts.root, JCODE_SDK_FALLBACK_VERSION, opts);
  }
}

/** One install→bridge→agent→health attempt at a specific jcode version. */
async function bootJcodeStack(
  io: BoxIO,
  binary: Buffer,
  secret: string,
  root: string,
  version: string,
  opts: WaitOptions,
): Promise<{ logTail: string }> {
  const jcodeBin = await installJcode(io, version);
  await startJcodeBridge(io, jcodeBin, root, opts);
  await bootJcodeAgent(io, binary, secret, root);
  return waitForJcodeAgentHealth(io, root, opts);
}

/** Tear down a half-started jcode stack so a fallback version installs clean. */
async function resetJcode(io: BoxIO, root: string): Promise<void> {
  const p = jcodePaths(root);
  await io.exec(
    `bash -lc ${shellQuote(
      `pkill -f jcode || true; pkill -f runtime-agent || true; ` +
        `rm -f ${p.apiSocket} ${p.daemonSocket}; rm -rf /tmp/node_modules/@1jehuang`,
    )}`,
  );
}
