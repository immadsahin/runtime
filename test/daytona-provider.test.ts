import assert from "node:assert/strict";
import { test } from "node:test";

import { toRuntimeComputer } from "@/lib/db/mappers";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import type { RuntimeProvider } from "@/lib/runtime/types";

const RETIRED = /Batch execution has been retired/;
const NOT_WIRED = /not on the Daytona provider/;

test("provider identifies as the daytona backend without credentials", () => {
  // Constructing must not read DAYTONA_* env (lazy client) so selection and
  // tests work in any environment.
  assert.equal(new DaytonaRuntimeProvider().name, "daytona");
});

// Exercise the methods through the RuntimeProvider interface — the shape callers
// actually invoke — even though the implementations ignore their arguments.
test("retired batch methods reject/throw with the retirement message", async () => {
  const p: RuntimeProvider = new DaytonaRuntimeProvider();
  await assert.rejects(
    p.executeJob({
      workspaceId: "w",
      sandboxId: "s",
      jobId: "j",
      agent: "claude",
      prompt: "hi",
      env: {},
    }),
    RETIRED,
  );
  await assert.rejects(
    p.getJobResult({ workspaceId: "w", sandboxId: "s", jobId: "j", resultPath: "r" }),
    RETIRED,
  );
  // Synchronous surfaces throw rather than return a rejected promise.
  assert.throws(() => p.getJobPaths({ workspaceId: "w", jobId: "j" }), RETIRED);
  assert.throws(
    () => p.streamLogs({ workspaceId: "w", sandboxId: "s", jobId: "j", logPath: "l" }),
    RETIRED,
  );
});

test("unwired workspace methods reject pointing at the AgentClient path", async () => {
  const p: RuntimeProvider = new DaytonaRuntimeProvider();
  await assert.rejects(
    p.createWorkspace({
      workspaceId: "w",
      repoFullName: "a/b",
      baseBranch: "main",
      branch: "x",
      env: {},
    }),
    NOT_WIRED,
  );
  await assert.rejects(p.sandboxAlive("s"), NOT_WIRED);
  await assert.rejects(p.commitWorkspace({
    workspaceId: "w",
    sandboxId: "s",
    message: "m",
    author: { name: "a", email: "a@b.co" },
  }), NOT_WIRED);
});

test("toRuntimeComputer maps provision_timings and omits the agent secret", () => {
  const computer = toRuntimeComputer({
    id: "c1",
    owner_id: "o1",
    project_id: "p1",
    status: "ready",
    image_version: "v1",
    daytona_sandbox_id: "sb1",
    agent_base_url: "https://8080-sb1.daytonaproxy01.net",
    agent_secret: "super-secret",
    provision_timings: {
      stages: [
        { stage: "sandbox_create", ms: 4000 },
        { stage: "agent_upload", ms: 15000 },
      ],
      totalMs: 19000,
    },
    error_message: null,
    last_active_at: null,
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
  });

  assert.equal(computer.provisionTimings?.totalMs, 19000);
  assert.equal(computer.provisionTimings?.stages[1].stage, "agent_upload");
  // The secret must never ride along on the domain object.
  assert.ok(!("agentSecret" in computer));
  assert.ok(!Object.values(computer).includes("super-secret"));
});

test("toRuntimeComputer tolerates absent or malformed provision_timings", () => {
  const base = {
    id: "c",
    owner_id: "o",
    project_id: "p",
    status: "provisioning" as const,
    image_version: "v1",
    daytona_sandbox_id: null,
    agent_base_url: null,
    agent_secret: null,
    error_message: null,
    last_active_at: null,
    created_at: "t",
    updated_at: "t",
  };
  assert.equal(toRuntimeComputer({ ...base, provision_timings: null }).provisionTimings, null);
  assert.equal(
    toRuntimeComputer({ ...base, provision_timings: { garbage: true } }).provisionTimings,
    null,
  );
});
