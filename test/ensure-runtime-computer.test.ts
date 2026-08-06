import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ensureRuntimeComputer,
  type EnsureRuntimeComputerDependencies,
  type RuntimeComputerProvisioner,
} from "@/lib/runtime/ensure-runtime-computer";
import type { RuntimeComputer } from "@/lib/runtime/types";

function computer(overrides: Partial<RuntimeComputer> = {}): RuntimeComputer {
  return {
    id: "computer-1",
    projectId: "project-1",
    provider: "daytona",
    placementKey: "project:project-1",
    topology: "shared",
    status: "provisioning",
    imageVersion: "v1",
    providerComputerId: null,
    daytonaSandboxId: null,
    agentBaseUrl: null,
    provisionTimings: null,
    errorMessage: null,
    lastActiveAt: null,
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

/**
 * A faithful in-memory stand-in for the claim RPC: its claim operation is
 * atomic, while provision happens outside it. This exercises the actual
 * orchestration boundary where concurrent first-workspace requests used to
 * create duplicate Daytona boxes.
 */
function concurrencyHarness() {
  let row: RuntimeComputer | null = null;
  let secret: string | null = null;

  const deps: EnsureRuntimeComputerDependencies = {
    claim: async (input) => {
      if (!row) {
        row = computer({
          projectId: input.projectId,
          provider: input.provider,
          placementKey: input.placementKey,
          topology: input.topology,
          imageVersion: input.imageVersion,
        });
        secret = input.agentSecret;
        return { computer: row, shouldProvision: true };
      }
      if (row.status === "error" || row.status === "stopped") {
        row = {
          ...row,
          status: "provisioning",
          daytonaSandboxId: null,
          agentBaseUrl: null,
          provisionTimings: null,
          errorMessage: null,
        };
        secret = input.agentSecret;
        return { computer: row, shouldProvision: true };
      }
      return { computer: row, shouldProvision: false };
    },
    getByPlacement: async () => row,
    readSecret: async () => secret,
    update: async (_id, patch) => {
      assert.ok(row);
      row = {
        ...row,
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.providerComputerId !== undefined && {
          providerComputerId: patch.providerComputerId,
          daytonaSandboxId: patch.providerComputerId,
        }),
        ...(patch.agentBaseUrl !== undefined && { agentBaseUrl: patch.agentBaseUrl }),
        ...(patch.provisionTimings !== undefined && {
          provisionTimings: patch.provisionTimings,
        }),
        ...(patch.errorMessage !== undefined && { errorMessage: patch.errorMessage }),
      };
    },
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    now: Date.now,
  };

  return { deps, row: () => row };
}

const input = {
  projectId: "project-1",
  repoFullName: "acme/runtime",
};

test("concurrent first-workspace ensures provision exactly one Runtime Computer", async () => {
  const harness = concurrencyHarness();
  let provisions = 0;
  const provider: RuntimeComputerProvisioner = {
    provisionComputer: async () => {
      provisions += 1;
      // Keep the owner request in the external-provision phase long enough
      // for its peer to observe the durable provisioning row and wait.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        computerId: "daytona-1",
        controlBaseUrl: "https://agent.example.test",
        controlHeaders: { "x-daytona-preview-token": "preview-token" },
        browserBaseUrl: "https://signed.example.test",
        sandboxId: "daytona-1",
        agentBaseUrl: "https://agent.example.test",
        daytonaPreviewToken: "preview-token",
        signedWsBaseUrl: "https://signed.example.test",
        timings: { stages: [{ stage: "sandbox_create", ms: 10 }], totalMs: 10 },
      };
    },
  };

  const [first, second] = await Promise.all([
    ensureRuntimeComputer(provider, input, harness.deps),
    ensureRuntimeComputer(provider, input, harness.deps),
  ]);

  assert.equal(provisions, 1);
  assert.equal(first.computer.id, second.computer.id);
  assert.equal([first.provisioned, second.provisioned].filter(Boolean).length, 1);
  assert.equal(harness.row()?.status, "ready");
});

test("a provision failure is persisted as an error for a later retry", async () => {
  const harness = concurrencyHarness();
  await assert.rejects(
    () =>
      ensureRuntimeComputer(
        { provisionComputer: async () => Promise.reject(new Error("Daytona unavailable")) },
        input,
        harness.deps,
      ),
    /Daytona unavailable/,
  );

  assert.equal(harness.row()?.status, "error");
  assert.match(harness.row()?.errorMessage ?? "", /provisioning failed/i);
});

test("a failed Runtime Computer can be claimed and provisioned by a retry", async () => {
  const harness = concurrencyHarness();
  let provisions = 0;
  const provider: RuntimeComputerProvisioner = {
    provisionComputer: async () => {
      provisions += 1;
      if (provisions === 1) throw new Error("Daytona unavailable");
      return {
        computerId: "daytona-retry",
        controlBaseUrl: "https://agent.example.test",
        controlHeaders: { "x-daytona-preview-token": "preview-token" },
        browserBaseUrl: "https://signed.example.test",
        sandboxId: "daytona-retry",
        agentBaseUrl: "https://agent.example.test",
        daytonaPreviewToken: "preview-token",
        signedWsBaseUrl: "https://signed.example.test",
        timings: { stages: [{ stage: "sandbox_create", ms: 10 }], totalMs: 10 },
      };
    },
  };

  await assert.rejects(() => ensureRuntimeComputer(provider, input, harness.deps));

  const retried = await ensureRuntimeComputer(provider, input, harness.deps);

  assert.equal(provisions, 2);
  assert.equal(retried.provisioned, true);
  assert.equal(harness.row()?.status, "ready");
  assert.equal(harness.row()?.providerComputerId, "daytona-retry");
});

test("an isolated placement retains its provider, workspace key, and template version", async () => {
  const harness = concurrencyHarness();
  const ensured = await ensureRuntimeComputer(
    {
      provisionComputer: async () => ({
        computerId: "e2b-1",
        controlBaseUrl: "https://agent.example.test",
        controlHeaders: {},
        browserBaseUrl: "https://agent.example.test",
        timings: { stages: [{ stage: "sandbox_create", ms: 10 }], totalMs: 10 },
      }),
    },
    {
      ...input,
      provider: "e2b",
      placementKey: "workspace:workspace-1",
      topology: "isolated",
      imageVersion: "runtime-computer-e2b-v1",
    },
    harness.deps,
  );

  assert.equal(ensured.computer.provider, "e2b");
  assert.equal(ensured.computer.placementKey, "workspace:workspace-1");
  assert.equal(ensured.computer.topology, "isolated");
  assert.equal(ensured.computer.imageVersion, "runtime-computer-e2b-v1");
});
