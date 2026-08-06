import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  e2bAgentBaseUrl,
  E2BRuntimeProvider,
  type E2BSandbox,
  type E2BSandboxClient,
} from "@/lib/runtime/e2b-provider";
import { getRuntimeProvider, resetRuntimeProvider } from "@/lib/runtime/provider";

type Calls = {
  created: number;
  secure?: boolean;
  lifecycle?: { onTimeout: { action: "pause"; keepMemory: boolean } };
  connected: string[];
  paused: string[];
  killed: string[];
  commands: Array<{ command: string; background?: boolean }>;
  uploads: string[];
};

function sandbox(id = "e2b-1"): E2BSandbox {
  return {
    sandboxId: id,
    commands: {
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
    files: { write: async () => undefined },
    getHost: () => "agent.e2b.example.test",
    isRunning: async () => true,
  };
}

function fakeClient(
  calls: Calls,
  box: E2BSandbox = sandbox(),
  state = "running",
): E2BSandboxClient {
  return {
    create: async (_template, options) => {
      calls.created += 1;
      calls.secure = options.secure;
      calls.lifecycle = options.lifecycle;
      return box;
    },
    connect: async (id) => {
      calls.connected.push(id);
      return box;
    },
    getInfo: async () => ({ state }),
    pause: async (id) => {
      calls.paused.push(id);
      return true;
    },
    kill: async (id) => {
      calls.killed.push(id);
      return true;
    },
  };
}

function calls(): Calls {
  return { created: 0, connected: [], paused: [], killed: [], commands: [], uploads: [] };
}

async function withE2BEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousKey = process.env.E2B_API_KEY;
  const previousBinary = process.env.RUNTIME_AGENT_BINARY_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-e2b-test-"));
  const binary = path.join(dir, "runtime-agent");
  await writeFile(binary, "test runtime agent");
  process.env.E2B_API_KEY = "test-only-key";
  process.env.RUNTIME_AGENT_BINARY_PATH = binary;
  try {
    return await fn();
  } finally {
    if (previousKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = previousKey;
    if (previousBinary === undefined) delete process.env.RUNTIME_AGENT_BINARY_PATH;
    else process.env.RUNTIME_AGENT_BINARY_PATH = previousBinary;
    await rm(dir, { recursive: true, force: true });
  }
}

test("E2B provider constructs without credentials and exposes isolated placement", () => {
  const provider = new E2BRuntimeProvider();
  assert.equal(provider.name, "e2b");
  assert.equal(provider.kind, "compute");
  assert.equal(provider.topology, "isolated");
  assert.equal(provider.placementVersion(), "runtime-computer-e2b-v1");
});

test("E2B provider selection remains disabled until explicitly enabled", () => {
  const previousProvider = process.env.RUNTIME_PROVIDER;
  const previousEnabled = process.env.RUNTIME_ENABLE_E2B;
  process.env.RUNTIME_PROVIDER = "e2b";
  delete process.env.RUNTIME_ENABLE_E2B;
  resetRuntimeProvider();
  try {
    assert.throws(() => getRuntimeProvider(), /E2B is disabled/);
    process.env.RUNTIME_ENABLE_E2B = "true";
    assert.equal(getRuntimeProvider().name, "e2b");
  } finally {
    resetRuntimeProvider();
    if (previousProvider === undefined) delete process.env.RUNTIME_PROVIDER;
    else process.env.RUNTIME_PROVIDER = previousProvider;
    if (previousEnabled === undefined) delete process.env.RUNTIME_ENABLE_E2B;
    else process.env.RUNTIME_ENABLE_E2B = previousEnabled;
  }
});

test("E2B agent host is always normalized to an HTTPS base URL", () => {
  assert.equal(e2bAgentBaseUrl("sandbox.example.test"), "https://sandbox.example.test");
  assert.equal(e2bAgentBaseUrl("https://sandbox.example.test/"), "https://sandbox.example.test");
});

test("E2B provisions agent upload, boot, health, and cleans up a failed provision", async () => {
  await withE2BEnv(async () => {
    const recorded = calls();
    const box = sandbox();
    box.commands.run = async (command, options) => {
      recorded.commands.push({ command, background: options?.background });
      return {
        stdout: command.includes("127.0.0.1:8080/health") ? "200" : "",
        stderr: "",
        exitCode: 0,
      };
    };
    box.files.write = async (remotePath) => {
      recorded.uploads.push(remotePath);
    };
    const provider = new E2BRuntimeProvider(fakeClient(recorded, box));

    const provisioned = await provider.provisionComputer({ secret: "agent-secret" });

    assert.equal(provisioned.computerId, "e2b-1");
    assert.equal(provisioned.controlBaseUrl, "https://agent.e2b.example.test");
    // Keep E2B's controller API secured. This is independent from public agent
    // traffic, which the runtime-agent authorizes with Runtime JWTs.
    assert.equal(recorded.secure, true);
    assert.deepEqual(recorded.lifecycle, { onTimeout: { action: "pause", keepMemory: true } });
    assert.deepEqual(recorded.uploads, ["/home/runtime/runtime-agent.gz"]);
    assert.ok(recorded.commands.some(({ background }) => background));
    assert.equal(provisioned.timings.stages.map((stage) => stage.stage).join(","),
      "sandbox_create,agent_upload,agent_boot,health_check");

    const failed = calls();
    const failingBox = sandbox("e2b-failed");
    failingBox.files.write = async () => { throw new Error("upload failed"); };
    const failingProvider = new E2BRuntimeProvider(fakeClient(failed, failingBox));
    await assert.rejects(failingProvider.provisionComputer({ secret: "agent-secret" }), /upload failed/);
    assert.deepEqual(failed.killed, ["e2b-failed"]);

    const failedCleanup = calls();
    const failedCleanupBox = sandbox("e2b-cleanup-failed");
    failedCleanupBox.files.write = async () => { throw new Error("upload failed"); };
    const failedCleanupClient = fakeClient(failedCleanup, failedCleanupBox);
    // A genuine controller failure during cleanup throws (kill returning false
    // now means "already gone" — see the destroy tests below), so provisioning
    // must surface both the original and the cleanup cause.
    failedCleanupClient.kill = async () => { throw new Error("kill failed"); };
    await assert.rejects(
      new E2BRuntimeProvider(failedCleanupClient).provisionComputer({ secret: "agent-secret" }),
      /cleanup also failed for e2b-cleanup-failed/,
    );
  });
});

test("E2B treats paused computers as resumable placements and delegates lifecycle", async () => {
  await withE2BEnv(async () => {
    const recorded = calls();
    const provider = new E2BRuntimeProvider(fakeClient(recorded, sandbox(), "paused"));

    assert.equal(await provider.computerAlive("e2b-1"), true);
    assert.equal(await provider.computerState("e2b-1"), "paused");
    await assert.rejects(
      provider.agentTarget("e2b-1", "agent-secret"),
      /paused; resume its workspace/,
    );
    await provider.pauseComputer("e2b-1");
    await provider.resumeComputer("e2b-1");
    await provider.destroyComputer("e2b-1");

    assert.deepEqual(recorded.paused, ["e2b-1"]);
    // A normal agent lookup must not attach to (and therefore resume) a
    // timeout-paused sandbox. Only the explicit lifecycle resume may connect.
    assert.deepEqual(recorded.connected, ["e2b-1"]);
    assert.deepEqual(recorded.killed, ["e2b-1"]);

    const alreadyRemoved = calls();
    await new E2BRuntimeProvider(
      fakeClient(alreadyRemoved, sandbox("e2b-removed"), "missing"),
    ).destroyComputer("e2b-removed");
    assert.deepEqual(alreadyRemoved.killed, []);

    const unavailableController = fakeClient(calls(), sandbox());
    unavailableController.getInfo = async () => { throw new Error("controller unavailable"); };
    const unavailableProvider = new E2BRuntimeProvider(unavailableController);
    await assert.rejects(
      unavailableProvider.computerAlive("e2b-1"),
      /controller unavailable/,
    );
    await assert.rejects(
      unavailableProvider.destroyComputer("e2b-1"),
      /controller unavailable/,
    );

    const killFailure = fakeClient(calls(), sandbox());
    killFailure.kill = async () => { throw new Error("E2B delete failed"); };
    await assert.rejects(
      new E2BRuntimeProvider(killFailure).destroyComputer("e2b-1"),
      /E2B delete failed/,
    );

    // E2B's kill returns false only for an already-removed sandbox (reaped in the
    // window after the existence check); that is an idempotent terminal success,
    // not a cleanup failure, so destroy must resolve rather than throw.
    const killRaced = calls();
    const racedClient = fakeClient(killRaced, sandbox());
    racedClient.kill = async (id) => { killRaced.killed.push(id); return false; };
    await new E2BRuntimeProvider(racedClient).destroyComputer("e2b-1");
    assert.deepEqual(killRaced.killed, ["e2b-1"]);
  });
});
