import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  AGENT_BINARY_PATH,
  AGENT_GZ_PATH,
  agentLaunchScript,
  agentPrepScript,
  bootAgent,
  compressAgent,
  deployAgent,
  ProvisionTimer,
  shellQuote,
  uploadAgent,
  waitForAgentHealth,
  type BoxIO,
  type ExecResult,
} from "@/lib/runtime/daytona/deploy";

/** A scripted BoxIO: exec returns queued results by matching a predicate. */
function fakeBox(
  handlers: Array<{ match: (cmd: string) => boolean; result: ExecResult }>,
): {
  io: BoxIO;
  execCalls: string[];
  launchCalls: string[];
  uploads: Array<{ path: string; bytes: number }>;
} {
  const execCalls: string[] = [];
  const launchCalls: string[] = [];
  const uploads: Array<{ path: string; bytes: number }> = [];
  const io: BoxIO = {
    exec: async (command) => {
      execCalls.push(command);
      const handler = handlers.find((h) => h.match(command));
      return handler ? handler.result : { stdout: "", exitCode: 0 };
    },
    launch: async (command) => {
      launchCalls.push(command);
    },
    upload: async (data, remotePath) => {
      uploads.push({ path: remotePath, bytes: data.length });
    },
  };
  return { io, execCalls, launchCalls, uploads };
}

const noSleep = () => Promise.resolve();

test("shellQuote wraps and escapes embedded single quotes", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("compressAgent gzips and round-trips", () => {
  const original = Buffer.from("runtime-agent binary bytes".repeat(100));
  const gz = compressAgent(original);
  assert.ok(gz.length < original.length, "expected compression to shrink");
  assert.deepEqual(gunzipSync(gz), original);
});

test("agentPrepScript gunzips then chmods (synchronous, so failures surface)", () => {
  const script = agentPrepScript();
  assert.ok(script.includes(`gunzip -f ${AGENT_GZ_PATH}`));
  assert.ok(script.includes(`chmod 755 ${AGENT_BINARY_PATH}`));
});

test("agentLaunchScript launches detached with the secret and port", () => {
  const script = agentLaunchScript("s3cr3t");
  assert.ok(script.includes("setsid env RUNTIME_AGENT_SECRET='s3cr3t'"));
  assert.ok(script.includes("PORT=8080"));
  // Detached and input-closed so it outlives the launch call.
  assert.ok(script.trim().endsWith("< /dev/null &"));
});

test("agentLaunchScript injects project secrets as quoted env", () => {
  const script = agentLaunchScript("k", { CLAUDE_CODE_OAUTH_TOKEN: "tok en", GITHUB_TOKEN: "g" });
  assert.ok(script.includes("CLAUDE_CODE_OAUTH_TOKEN='tok en'"));
  assert.ok(script.includes("GITHUB_TOKEN='g'"));
});

test("ProvisionTimer records ordered stages, total, and fires onStage", async () => {
  let clock = 1000;
  const seen: string[] = [];
  const timer = new ProvisionTimer({
    now: () => clock,
    onStage: (t) => seen.push(`${t.stage}:${t.ms}`),
  });
  await timer.stage("sandbox_create", async () => {
    clock += 40;
  });
  await timer.stage("agent_upload", async () => {
    clock += 15;
  });
  const timings = timer.timings();
  assert.deepEqual(seen, ["sandbox_create:40", "agent_upload:15"]);
  assert.deepEqual(
    timings.stages.map((s) => [s.stage, s.ms]),
    [["sandbox_create", 40], ["agent_upload", 15]],
  );
  assert.equal(timings.totalMs, 55);
});

test("ProvisionTimer records a stage even when it throws", async () => {
  let clock = 0;
  const timer = new ProvisionTimer({ now: () => (clock += 10) });
  await assert.rejects(
    timer.stage("agent_boot", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(timer.timings().stages[0].stage, "agent_boot");
});

test("uploadAgent uploads the compressed binary to the .gz path", async () => {
  const box = fakeBox([]);
  await uploadAgent(box.io, Buffer.from("x".repeat(500)));
  assert.equal(box.uploads.length, 1);
  assert.equal(box.uploads[0].path, AGENT_GZ_PATH);
  assert.ok(box.uploads[0].bytes > 0);
});

test("bootAgent throws on prep failure and never launches the daemon", async () => {
  const box = fakeBox([
    { match: (c) => c.includes("gunzip"), result: { stdout: "gzip: not found", exitCode: 1 } },
  ]);
  await assert.rejects(bootAgent(box.io, "s"), /agent prep failed \(exit 1\): gzip: not found/);
  assert.equal(box.launchCalls.length, 0);
});

test("bootAgent launches the daemon via the async path after a clean prep", async () => {
  const box = fakeBox([]);
  await bootAgent(box.io, "sec", { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  assert.equal(box.launchCalls.length, 1);
  // The launch is wrapped in `bash -lc '<quoted>'`, so assert on markers that
  // survive shell-quoting (the `=` prefixes and the values themselves).
  assert.ok(box.launchCalls[0].startsWith("bash -lc "));
  assert.ok(box.launchCalls[0].includes("setsid env RUNTIME_AGENT_SECRET="));
  assert.ok(box.launchCalls[0].includes("CLAUDE_CODE_OAUTH_TOKEN="));
  assert.ok(box.launchCalls[0].includes("tok"));
});

test("waitForAgentHealth resolves once the probe returns 200", async () => {
  let probes = 0;
  const box = fakeBox([
    {
      match: (c) => c.includes("http_code") || c.includes("/health"),
      result: { stdout: "", exitCode: 0 },
    },
  ]);
  // Override exec to fail twice then succeed, and serve the log tail.
  box.io.exec = async (command) => {
    if (command.includes("curl")) {
      probes += 1;
      return { stdout: probes >= 3 ? "200" : "000", exitCode: 0 };
    }
    if (command.includes("cat")) return { stdout: "listening on :8080", exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  const result = await waitForAgentHealth(box.io, { attempts: 5, intervalMs: 1, sleep: noSleep });
  assert.equal(result.logTail, "listening on :8080");
  assert.equal(probes, 3);
});

test("waitForAgentHealth throws with the log tail when the agent never binds", async () => {
  const box = fakeBox([
    { match: (c) => c.includes("curl"), result: { stdout: "000", exitCode: 0 } },
    { match: (c) => c.includes("cat"), result: { stdout: "panic: bad secret", exitCode: 0 } },
  ]);
  await assert.rejects(
    waitForAgentHealth(box.io, { attempts: 2, intervalMs: 1, sleep: noSleep }),
    /did not bind :8080[\s\S]*panic: bad secret/,
  );
});

test("deployAgent runs upload → prep → launch → health in order", async () => {
  const order: string[] = [];
  const io: BoxIO = {
    exec: async (command) => {
      if (command.includes("gunzip")) order.push("prep");
      if (command.includes("curl")) {
        order.push("health");
        return { stdout: "200", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    },
    launch: async () => {
      order.push("launch");
    },
    upload: async () => {
      order.push("upload");
    },
  };
  await deployAgent(io, Buffer.from("bin"), "secret", { attempts: 1, sleep: noSleep });
  assert.deepEqual(order.slice(0, 4), ["upload", "prep", "launch", "health"]);
});
