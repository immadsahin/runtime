import { randomBytes } from "node:crypto";

import type {
  ProvisionedComputer,
  ProvisionComputerInput,
} from "@/lib/runtime/daytona-provider";
import type { RuntimeComputer, RuntimeComputerStatus } from "@/lib/runtime/types";

const POLL_INTERVAL_MS = 500;
const PROVISION_WAIT_MS = 3 * 60_000;

export type RuntimeComputerProvisioner = {
  provisionComputer(input: ProvisionComputerInput): Promise<ProvisionedComputer>;
};

type Claim = (input: {
  projectId: string;
  agentSecret: string;
}) => Promise<{ computer: RuntimeComputer; shouldProvision: boolean }>;

export type EnsureRuntimeComputerDependencies = {
  claim: Claim;
  getByProject: (projectId: string) => Promise<RuntimeComputer | null>;
  readSecret: (computerId: string) => Promise<string | null>;
  update: (
    id: string,
    patch: {
      status?: RuntimeComputerStatus;
      daytonaSandboxId?: string | null;
      agentBaseUrl?: string | null;
      provisionTimings?: RuntimeComputer["provisionTimings"];
      errorMessage?: string | null;
      touchActive?: boolean;
    },
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type EnsureRuntimeComputerInput = {
  projectId: string;
  repoFullName: string;
  githubToken?: string;
  sessionEnv?: Record<string, string>;
};

export type EnsuredRuntimeComputer = {
  computer: RuntimeComputer;
  /** True only for the request that performed the external provision. */
  provisioned: boolean;
  /** Server-only secret for the immediately following agent control calls. */
  agentSecret: string;
};

/**
 * Find or lazily provision the single Runtime Computer for a project.
 *
 * The database RPC atomically elects exactly one request to own provision.
 * Non-owners wait on the durable row rather than starting duplicate Daytona
 * boxes. The unique project constraint is deliberately retained as a second,
 * database-enforced line of defence.
 */
export async function ensureRuntimeComputer(
  provider: RuntimeComputerProvisioner,
  input: EnsureRuntimeComputerInput,
  deps: EnsureRuntimeComputerDependencies,
): Promise<EnsuredRuntimeComputer> {
  const agentSecret = randomBytes(32).toString("hex");
  const claim = await deps.claim({
    projectId: input.projectId,
    agentSecret,
  });

  if (!claim.shouldProvision) {
    const computer = await waitForReadyComputer(input.projectId, deps);
    const persistedSecret = await deps.readSecret(computer.id);
    if (!persistedSecret) {
      throw new Error("Runtime Computer secret is missing after provisioning.");
    }
    return { computer, provisioned: false, agentSecret: persistedSecret };
  }

  try {
    const provisioned = await provider.provisionComputer({
      secret: agentSecret,
      repoFullName: input.repoFullName,
      githubToken: input.githubToken,
      sessionEnv: input.sessionEnv,
    });
    await deps.update(claim.computer.id, {
      status: "ready",
      daytonaSandboxId: provisioned.sandboxId,
      agentBaseUrl: provisioned.agentBaseUrl,
      provisionTimings: provisioned.timings,
      errorMessage: null,
      touchActive: true,
    });
    const computer = await deps.getByProject(input.projectId);
    if (!computer || computer.status !== "ready" || !computer.daytonaSandboxId) {
      throw new Error("Runtime Computer was not persisted as ready.");
    }
    return { computer, provisioned: true, agentSecret };
  } catch (error) {
    await deps.update(claim.computer.id, {
      status: "error",
      errorMessage: "Runtime Computer provisioning failed. Check Runtime setup and try again.",
    }).catch((updateError: unknown) =>
      console.error("Could not save Runtime Computer failure state", updateError),
    );
    throw error;
  }
}

async function waitForReadyComputer(
  projectId: string,
  deps: EnsureRuntimeComputerDependencies,
): Promise<RuntimeComputer> {
  const deadline = deps.now() + PROVISION_WAIT_MS;
  while (true) {
    const computer = await deps.getByProject(projectId);
    if (!computer) {
      throw new Error("Runtime Computer claim disappeared before provisioning completed.");
    }
    if (computer.status === "ready" && computer.daytonaSandboxId) return computer;
    if (computer.status === "error" || computer.status === "stopped") {
      throw new Error("Runtime Computer provisioning did not complete.");
    }
    if (deps.now() >= deadline) {
      throw new Error("Timed out waiting for Runtime Computer provisioning.");
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/** Server-only secrets that Claude needs after the agent is booted. */
export function runtimeSessionEnvironment(): Record<string, string> {
  const keys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY"] as const;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value]] : [];
    }),
  );
}
