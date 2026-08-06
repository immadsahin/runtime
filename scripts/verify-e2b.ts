/**
 * E2B provider real-box acceptance verifier. Exercises the production boundaries
 * that hermetic tests cannot prove, none of which need a Claude token:
 *
 *   provision (create + upload/boot agent + health + mirror clone)
 *   → agent reachable through the PUBLIC getHost URL  (proves secure:false: the
 *     E2B edge does NOT 401 unauthenticated agent traffic — the runtime-agent's
 *     Runtime-JWT check is the boundary)
 *   → real-kernel Docker: dockerd + `docker run hello-world` on the box
 *   → pause → resume  (state survives; connect resumes the same placement)
 *   → destroy  (kill is idempotent terminal cleanup)
 *
 * Run after building the Linux agent and the runtime-computer-e2b-v1 template:
 *
 *   ./scripts/build-agent.sh
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs \
 *     --env-file=.env.local scripts/verify-e2b.ts
 *
 * Required env: E2B_API_KEY, E2B_TEMPLATE (default runtime-computer-e2b-v1).
 * Optional: VERIFY_REPO (default octocat/Hello-World) exercises the mirror clone.
 */
import { randomBytes } from "node:crypto";

import { Sandbox } from "e2b";

import { E2BRuntimeProvider } from "@/lib/runtime/e2b-provider";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is required (put it in .env.local).");
const repoFullName = process.env.VERIFY_REPO ?? "octocat/Hello-World";

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    console.log(`  ✓ ${name} (${Math.round(performance.now() - start)}ms)`);
    return result;
  } catch (error) {
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const provider = new E2BRuntimeProvider();
  const secret = randomBytes(24).toString("hex");
  let computerId: string | null = null;

  try {
    const provisioned = await step("provision (create → agent → health → mirror)", async () => {
      const result = await provider.provisionComputer({
        secret,
        labels: { "runtime.verify": "e2b" },
        repoFullName,
        onStage: (stage, ms) => console.log(`      · ${stage} ${ms}ms`),
      });
      computerId = result.computerId;
      console.log(`      sandbox=${result.computerId} control=${result.controlBaseUrl}`);
      return result;
    });

    // BLOCKER-1 FIX: the agent must be reachable through E2B's public edge with
    // no E2B traffic token. /health is unauthenticated on the agent, so a 200
    // proves the sandbox was created with secure:false (secure:true would 401
    // here at the edge before reaching the agent).
    await step("agent /health reachable through public getHost URL (secure:false)", async () => {
      const res = await fetch(`${provisioned.controlBaseUrl}/health`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 200) {
        throw new Error(`expected 200 from public /health, got ${res.status} — edge likely still secure`);
      }
    });

    await step("agentTarget resolves a running target", async () => {
      const target = await provider.agentTarget(computerId!, secret);
      if (!target.controlBaseUrl) throw new Error("agentTarget returned no controlBaseUrl");
    });

    // Real-kernel premise: start dockerd and run a container on the box. This is
    // what makes E2B the right isolated substrate (gVisor/Daytona cannot).
    await step("real-kernel Docker: dockerd + docker run hello-world", async () => {
      const box = await Sandbox.connect(computerId!, { apiKey });
      const ready = await box.commands.run(
        "docker info >/dev/null 2>&1 && echo UP || (sudo nohup dockerd >/tmp/dockerd.log 2>&1 & " +
          "for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; " +
          "docker info >/dev/null 2>&1 && echo UP || echo DOWN)",
        { timeoutMs: 90_000 },
      ) as { stdout: string };
      if (!/UP/.test(ready.stdout)) throw new Error("dockerd did not become ready on the box");
      const run = await box.commands.run("docker run --rm hello-world 2>&1", {
        timeoutMs: 120_000,
      }) as { stdout: string };
      if (!/Hello from Docker/.test(run.stdout)) {
        throw new Error(`hello-world did not run: ${run.stdout.slice(0, 300)}`);
      }
    });

    await step("pause → state=paused", async () => {
      await provider.pauseComputer(computerId!);
      const state = await provider.computerState(computerId!);
      if (state !== "paused") throw new Error(`expected paused, got ${state}`);
    });

    await step("resume → state=running", async () => {
      await provider.resumeComputer(computerId!);
      const state = await provider.computerState(computerId!);
      if (state !== "running") throw new Error(`expected running, got ${state}`);
    });

    await step("destroy → state=missing", async () => {
      await provider.destroyComputer(computerId!);
      computerId = null;
      // computerState of a killed sandbox must converge to missing.
      const provider2 = new E2BRuntimeProvider();
      const state = await provider2.computerState(provisioned.computerId);
      if (state !== "missing") throw new Error(`expected missing after destroy, got ${state}`);
    });

    console.log("\n✅ E2B provider acceptance passed.");
  } finally {
    if (computerId) {
      console.log(`\ncleaning up leftover sandbox ${computerId}…`);
      await provider.destroyComputer(computerId).catch((e) =>
        console.error(`  cleanup failed: ${(e as Error).message}`),
      );
    }
  }
}

main().catch((error) => {
  console.error("\n❌ E2B provider acceptance FAILED");
  console.error(error);
  process.exit(1);
});
