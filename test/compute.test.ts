import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureLiveSandbox, settleRunningJobs } from "@/lib/runtime/compute";
import type {
  Job,
  JobResult,
  JobStatus,
  RuntimeProvider,
  Workspace,
  WorkspaceStatus,
} from "@/lib/runtime/types";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    workspaceId: "ws-1",
    agent: "claude",
    status: "running",
    prompt: "hi",
    logPath: "/logs/job-1.log",
    resultPath: "/logs/job-1.result.json",
    executionHandle: null,
    logBytes: 42,
    exitCode: null,
    sessionId: null,
    costUsd: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeResult(overrides: Partial<JobResult> = {}): JobResult {
  return { status: "succeeded", exitCode: 0, finishedAt: "2026-01-01T00:01:00Z", ...overrides };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    provider: "modal",
    status: "ready",
    phase: null,
    branch: "runtime/x",
    baseBranch: "main",
    worktreePath: "/runtime/worktrees/x",
    sandboxId: "sb-1",
    volumeName: "vol-1",
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<RuntimeProvider> = {}): RuntimeProvider {
  return {
    name: "modal",
    sandboxAlive: async () => true,
    resumeWorkspace: async () => ({ sandboxId: "sb-new" }),
    ...overrides,
  } as unknown as RuntimeProvider;
}

// --- settleRunningJobs ------------------------------------------------------

test("settleRunningJobs settles a finished running job once, from queued/running", async () => {
  const transitions: { from: JobStatus[]; status: JobStatus; exitCode?: number | null; logBytes?: number }[] = [];
  await settleRunningJobs(makeWorkspace({ sandboxId: "sb-1" }), {
    listJobs: async () => [makeJob({ status: "running" })],
    getJobResult: async () => makeResult({ status: "failed", exitCode: 1 }),
    transitionJob: async (input) => {
      transitions.push({ from: input.from, status: input.patch.status, exitCode: input.patch.exitCode, logBytes: input.patch.logBytes });
      return makeJob({ status: "failed" });
    },
  });
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0].from, ["queued", "running"]);
  assert.equal(transitions[0].status, "failed");
  assert.equal(transitions[0].exitCode, 1);
  assert.equal(transitions[0].logBytes, 42);
});

test("settleRunningJobs ignores jobs whose result record is absent", async () => {
  let transitioned = 0;
  await settleRunningJobs(makeWorkspace(), {
    listJobs: async () => [makeJob({ status: "running" })],
    getJobResult: async () => null,
    transitionJob: async () => { transitioned += 1; return null; },
  });
  assert.equal(transitioned, 0);
});

test("settleRunningJobs skips jobs with no result path (never started)", async () => {
  let reads = 0;
  await settleRunningJobs(makeWorkspace(), {
    listJobs: async () => [makeJob({ status: "queued", resultPath: "" })],
    getJobResult: async () => { reads += 1; return makeResult(); },
    transitionJob: async () => null,
  });
  assert.equal(reads, 0);
});

test("settleRunningJobs swallows provider read failures", async () => {
  let transitioned = 0;
  await settleRunningJobs(makeWorkspace(), {
    listJobs: async () => [makeJob({ status: "running" })],
    getJobResult: async () => { throw new Error("provider down"); },
    transitionJob: async () => { transitioned += 1; return null; },
  });
  assert.equal(transitioned, 0);
});

test("settleRunningJobs does nothing when no jobs are active", async () => {
  let reads = 0;
  await settleRunningJobs(makeWorkspace(), {
    listJobs: async () => [makeJob({ status: "succeeded" })],
    getJobResult: async () => { reads += 1; return makeResult(); },
    transitionJob: async () => null,
  });
  assert.equal(reads, 0);
});

test("settleRunningJobs passes an empty sandbox id when the workspace has none", async () => {
  let seen = "unset";
  await settleRunningJobs(makeWorkspace({ sandboxId: null }), {
    listJobs: async () => [makeJob({ status: "queued" })],
    getJobResult: async (input) => { seen = input.sandboxId; return null; },
    transitionJob: async () => null,
  });
  assert.equal(seen, "");
});

// --- ensureLiveSandbox ------------------------------------------------------

test("ensureLiveSandbox surfaces the provider resolution error", async () => {
  const res = await ensureLiveSandbox(makeWorkspace(), {
    resolveProvider: () => ({ ok: false, status: 503, message: "no provider" }),
    transitionWorkspace: async () => null,
  });
  assert.deepEqual(res, { ok: false, status: 503, message: "no provider" });
});

test("ensureLiveSandbox fast-paths a live sandbox without any transition", async () => {
  let transitions = 0;
  const res = await ensureLiveSandbox(makeWorkspace({ sandboxId: "sb-1" }), {
    resolveProvider: () => ({ ok: true, provider: fakeProvider({ sandboxAlive: async () => true }) }),
    transitionWorkspace: async () => { transitions += 1; return null; },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.sandboxId, "sb-1");
  assert.equal(transitions, 0);
});

test("ensureLiveSandbox refuses when there is no durable volume", async () => {
  const res = await ensureLiveSandbox(makeWorkspace({ sandboxId: null, volumeName: null }), {
    resolveProvider: () => ({ ok: true, provider: fakeProvider({ sandboxAlive: async () => false }) }),
    transitionWorkspace: async () => null,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
});

test("ensureLiveSandbox resumes an expired sandbox onto fresh compute", async () => {
  const statuses: WorkspaceStatus[] = [];
  const res = await ensureLiveSandbox(makeWorkspace({ sandboxId: "sb-dead" }), {
    resolveProvider: () => ({
      ok: true,
      provider: fakeProvider({ sandboxAlive: async () => false, resumeWorkspace: async () => ({ sandboxId: "sb-fresh" }) }),
    }),
    transitionWorkspace: async (input) => { statuses.push(input.patch.status); return makeWorkspace(); },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.sandboxId, "sb-fresh");
  assert.deepEqual(statuses, ["resuming", "ready"]);
});

test("ensureLiveSandbox guards against a concurrent resume", async () => {
  let resumed = 0;
  const res = await ensureLiveSandbox(makeWorkspace({ sandboxId: null }), {
    resolveProvider: () => ({
      ok: true,
      provider: fakeProvider({ sandboxAlive: async () => false, resumeWorkspace: async () => { resumed += 1; return { sandboxId: "x" }; } }),
    }),
    transitionWorkspace: async () => null, // another tab already claimed the resume
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
  assert.equal(resumed, 0);
});

test("ensureLiveSandbox restores prior state when resume fails", async () => {
  const patches: { status: WorkspaceStatus; errorMessage?: string | null }[] = [];
  const res = await ensureLiveSandbox(makeWorkspace({ sandboxId: null, status: "suspended" }), {
    resolveProvider: () => ({
      ok: true,
      provider: fakeProvider({ sandboxAlive: async () => false, resumeWorkspace: async () => { throw new Error("modal down"); } }),
    }),
    transitionWorkspace: async (input) => { patches.push({ status: input.patch.status, errorMessage: input.patch.errorMessage }); return makeWorkspace(); },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 502);
  assert.equal(patches[0].status, "resuming");
  assert.equal(patches[1].status, "suspended");
  assert.equal(typeof patches[1].errorMessage, "string");
});
