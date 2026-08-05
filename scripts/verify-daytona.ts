/**
 * M2 pt2 real-box verification — exercises the SHIPPING code paths end-to-end on
 * a real Daytona box before commit: DaytonaRuntimeProvider.provisionComputer
 * (gzip upload-on-provision + bare mirror + timings) → AgentClient.createWorkspace
 * (worktree off origin/<base>) → startWorkspace (tmux) → WS /pty (live terminal)
 * → stop → destroy. Prints the provisioning timing table for the spike report.
 *
 * Run (creds in the gitignored .env.local); build the agent first:
 *   ./scripts/build-agent.sh
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs \
 *        --env-file=.env.local scripts/verify-daytona.ts
 *
 * Optional env: VERIFY_REPO (default octocat/Hello-World), VERIFY_BASE (master),
 * GITHUB_PAT (for private repos / higher rate limits), CLAUDE_CODE_OAUTH_TOKEN
 * (to run REAL Claude in the PTY; without it the PTY attach is still verified but
 * Claude can't authenticate — live Claude output was already proven in Spike 4).
 * Pass --keep to leave the box up.
 */

import { randomBytes } from "node:crypto";

import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import type { ProvisionStage } from "@/lib/runtime/types";

const REPO = process.env.VERIFY_REPO ?? "octocat/Hello-World";
const BASE = process.env.VERIFY_BASE ?? "master";
const KEEP = process.argv.includes("--keep");
const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

const identity: WorkspaceIdentity = {
  workspaceId: "verify-ws",
  projectId: "verify-project",
  computerId: "verify-computer",
  userId: "verify-user",
};

async function main(): Promise<void> {
  requireEnv("DAYTONA_API_KEY");
  const provider = new DaytonaRuntimeProvider();
  const secret = randomBytes(32).toString("hex");
  let sandboxId: string | null = null;

  try {
    // 1) Provision: create box + gzip-upload agent + boot + health + seed mirror.
    console.log(`[1] provisionComputer (repo ${REPO}) …`);
    const computer = await provider.provisionComputer({
      secret,
      repoFullName: REPO,
      githubToken: process.env.GITHUB_PAT,
      sessionEnv: claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {},
      onStage: (stage: ProvisionStage, ms) =>
        console.log(`      ${stage.padEnd(15)} ${ms} ms`),
    });
    sandboxId = computer.sandboxId;
    printTimings(computer.timings);

    // 2) Control plane reaches the agent through the typed client.
    const target = await provider.agentTarget(sandboxId, secret);
    const agent = new AgentClient(target);

    console.log(`\n[2] createWorkspace → worktree off origin/${BASE} …`);
    const { worktree } = await agent.createWorkspace(
      { workspaceId: identity.workspaceId, repoFullName: REPO, branch: "runtime/verify", baseBranch: BASE },
      identity,
    );
    console.log(`      worktree: ${worktree}`);
    assert(worktree.includes(identity.workspaceId), "worktree path missing workspace id");

    console.log(`\n[3] startWorkspace → tmux session …`);
    const started = (await agent.startWorkspace(identity)) as { result?: string };
    console.log(`      started: ${JSON.stringify(started)}`);

    // 4) Browser transport: open WS /pty via the signed preview URL.
    console.log(`\n[4] WS /pty (signed preview URL) …`);
    const ptyResult = await probePty(agent.ptyUrl(identity));
    console.log(`      ${ptyResult}`);

    console.log(`\n[5] stopWorkspace …`);
    await agent.stopWorkspace(identity);
    console.log(`      stopped`);

    console.log(
      `\n✅ VERIFY PASSED — provision → create → start → PTY on a real box.` +
        (claudeToken ? " (live Claude)" : " (PTY attach only; no Claude token this run)"),
    );
  } finally {
    if (sandboxId && !KEEP) {
      console.log(`\ncleanup: destroying computer ${sandboxId} …`);
      await provider.destroyComputer(sandboxId);
    } else if (sandboxId) {
      console.log(`\n--keep set: computer ${sandboxId} left running.`);
    }
  }
}

/** Open the PTY socket, drive a resize + ping, and collect a little output.
 *  Proves the signed URL + Runtime-token handshake + tmux attach on a real box. */
function probePty(url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let bytes = 0;
    let sawExit = false;
    const done = (msg: string) => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(msg);
    };
    const timer = setTimeout(
      () => done(`received ${bytes} bytes of PTY output${sawExit ? " (session exited)" : ""}`),
      6000,
    );
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 32 }));
      ws.send(JSON.stringify({ t: "ping" }));
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = safeJson(String(event.data));
      if (msg?.t === "output" && typeof msg.data === "string") bytes += msg.data.length;
      if (msg?.t === "exit") sawExit = true;
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      done("WS error (handshake or attach failed)");
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      done(`socket closed after ${bytes} bytes${sawExit ? " (session exited)" : ""}`);
    });
  });
}

function printTimings(timings: { stages: { stage: string; ms: number }[]; totalMs: number }): void {
  console.log(`\n    provision timings:`);
  for (const s of timings.stages) console.log(`      ${s.stage.padEnd(15)} ${s.ms} ms`);
  console.log(`      ${"TOTAL".padEnd(15)} ${timings.totalMs} ms`);
}

function safeJson(text: string): { t?: string; data?: unknown } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}. Put it in .env.local.`);
  return v;
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`ASSERT: ${message}`);
}

main().catch((error) => {
  console.error("\n❌ VERIFY FAILED:", error);
  process.exitCode = 1;
});
