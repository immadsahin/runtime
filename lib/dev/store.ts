import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";

/**
 * In-memory state for dev-no-supabase mode: created workspaces and the
 * per-project Runtime Computer. It lets the real create → provision → session
 * flow run end to end (against a real Daytona box) without any Supabase writes.
 * Process-lifetime only; cleared on restart. NEVER used when Supabase is on.
 */

// Back the maps with globalThis. In Next.js dev (Turbopack), server modules are
// evaluated in SEPARATE module graphs for API routes vs. page server components,
// so a plain module-level `new Map()` would give the create route and the
// workspace page DIFFERENT instances (create writes to one, the page reads an
// empty other → 404). A globalThis singleton is shared across every graph in the
// one server process.
type DevState = {
  workspaces: Map<string, Workspace>;
  computers: Map<string, RuntimeComputer>; // keyed by projectId
  secrets: Map<string, string>; // computerId -> agent secret
  seq: number;
};
const g = globalThis as unknown as { __runtimeDevStore?: DevState };
const state: DevState = (g.__runtimeDevStore ??= {
  workspaces: new Map(),
  computers: new Map(),
  secrets: new Map(),
  seq: 0,
});
const { workspaces, computers, secrets } = state;

function id(prefix: string): string {
  state.seq += 1;
  return `${prefix}-dev-${state.seq}`;
}
const nowIso = () => new Date().toISOString();

export const devStore = {
  // --- workspaces ---
  createWorkspace(input: {
    projectId: string;
    branch: string;
    baseBranch: string;
    provider: Workspace["provider"];
  }): Workspace {
    const ws: Workspace = {
      id: id("ws"),
      projectId: input.projectId,
      provider: input.provider,
      status: "creating",
      phase: null,
      branch: input.branch || `runtime/dev-${state.seq}`,
      baseBranch: input.baseBranch,
      worktreePath: "",
      sandboxId: null,
      volumeName: null,
      computerId: null,
      tmuxSession: null,
      agentWorkspaceId: null,
      lastActiveAt: nowIso(),
      errorMessage: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    workspaces.set(ws.id, ws);
    return ws;
  },
  getWorkspace(id: string): Workspace | undefined {
    return workspaces.get(id);
  },
  listWorkspaces(): Workspace[] {
    return [...workspaces.values()];
  },
  updateWorkspace(id: string, patch: Partial<Workspace>): void {
    const w = workspaces.get(id);
    if (w) workspaces.set(id, { ...w, ...patch, updatedAt: nowIso() });
  },

  // --- runtime computer (one per project) ---
  claimComputer(projectId: string, agentSecret: string): {
    computer: RuntimeComputer;
    shouldProvision: boolean;
  } {
    const existing = computers.get(projectId);
    // Reuse only a healthy, provisioned box; a failed/half-provisioned one is
    // re-provisioned so a retry after an error isn't stuck on a dead computer.
    if (existing && existing.status === "ready" && existing.daytonaSandboxId) {
      return { computer: existing, shouldProvision: false };
    }
    const computer: RuntimeComputer = {
      id: id("rc"),
      projectId,
      status: "provisioning",
      imageVersion: "jcode-dev",
      daytonaSandboxId: null,
      agentBaseUrl: null,
      provisionTimings: null,
      errorMessage: null,
      lastActiveAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    computers.set(projectId, computer);
    secrets.set(computer.id, agentSecret);
    return { computer, shouldProvision: true };
  },
  getComputerByProject(projectId: string): RuntimeComputer | undefined {
    return computers.get(projectId);
  },
  updateComputer(computerId: string, patch: Partial<RuntimeComputer>): void {
    for (const [projectId, c] of computers) {
      if (c.id === computerId) {
        computers.set(projectId, { ...c, ...patch, updatedAt: nowIso() });
        return;
      }
    }
  },
  getSecret(computerId: string): string | undefined {
    return secrets.get(computerId);
  },
};
