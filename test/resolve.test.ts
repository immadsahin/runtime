import assert from "node:assert/strict";
import { test } from "node:test";

import { hasActiveComputeWorkspace } from "@/lib/runtime/compute-lifecycle";

test("only active compute workspaces may resolve an agent target", () => {
  assert.equal(hasActiveComputeWorkspace({ status: "ready" }), true);
  assert.equal(hasActiveComputeWorkspace({ status: "idle" }), true);
  assert.equal(hasActiveComputeWorkspace({ status: "suspended" }), false);
  assert.equal(hasActiveComputeWorkspace({ status: "resuming" }), false);
  assert.equal(hasActiveComputeWorkspace({ status: "archived" }), false);
});
