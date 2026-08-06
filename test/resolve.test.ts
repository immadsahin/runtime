import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_PAUSE_MESSAGE,
  autoPauseWorkspaceTransition,
  hasActiveComputeWorkspace,
  pauseArchivedIsolatedComputer,
} from "@/lib/runtime/compute-lifecycle";

test("only active compute workspaces may resolve an agent target", () => {
  assert.equal(hasActiveComputeWorkspace({ status: "ready" }), true);
  assert.equal(hasActiveComputeWorkspace({ status: "idle" }), true);
  assert.equal(hasActiveComputeWorkspace({ status: "suspended" }), false);
  assert.equal(hasActiveComputeWorkspace({ status: "resuming" }), false);
  assert.equal(hasActiveComputeWorkspace({ status: "archived" }), false);
});

test("an auto-pause observation can only transition an active workspace", () => {
  const transition = autoPauseWorkspaceTransition("workspace-1");
  assert.deepEqual(transition, {
    id: "workspace-1",
    from: ["ready", "idle"],
    patch: { status: "suspended", errorMessage: AUTO_PAUSE_MESSAGE },
  });
  assert.equal(transition.from.includes("archiving"), false);
  assert.equal(transition.from.includes("restoring"), false);
  assert.equal(transition.from.includes("destroying"), false);
});

test("archiving an isolated computer pauses its persisted provider handle", async () => {
  const paused: string[] = [];
  await pauseArchivedIsolatedComputer(
    { providerComputerId: "e2b-1" },
    {
      topology: "isolated",
      pauseComputer: async (computerId) => { paused.push(computerId); },
    },
  );
  assert.deepEqual(paused, ["e2b-1"]);

  await pauseArchivedIsolatedComputer(
    { providerComputerId: "daytona-1" },
    {
      topology: "shared",
      pauseComputer: async () => { throw new Error("shared computer must not pause"); },
    },
  );

  await assert.rejects(
    pauseArchivedIsolatedComputer(
      { providerComputerId: null },
      { topology: "isolated", pauseComputer: async () => undefined },
    ),
    /no provider computer id/,
  );
});
