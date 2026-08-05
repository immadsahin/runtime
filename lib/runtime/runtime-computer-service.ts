/** Production wiring for lazy Runtime Computer provisioning. */
import {
  claimRuntimeComputer,
  getRuntimeComputerByProject,
  readRuntimeComputerSecret,
  updateRuntimeComputer,
} from "@/lib/db/repositories";
import {
  ensureRuntimeComputer,
  type EnsureRuntimeComputerInput,
  type EnsuredRuntimeComputer,
  type RuntimeComputerProvisioner,
} from "@/lib/runtime/ensure-runtime-computer";

const dependencies = {
  claim: claimRuntimeComputer,
  getByProject: getRuntimeComputerByProject,
  readSecret: readRuntimeComputerSecret,
  update: updateRuntimeComputer,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

export function ensureProjectRuntimeComputer(
  provider: RuntimeComputerProvisioner,
  input: EnsureRuntimeComputerInput,
): Promise<EnsuredRuntimeComputer> {
  return ensureRuntimeComputer(provider, input, dependencies);
}
