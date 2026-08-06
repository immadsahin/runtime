import { e2bEnabled, providerName } from "@/lib/env";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { E2BRuntimeProvider } from "@/lib/runtime/e2b-provider";
import { LocalRuntimeProvider } from "@/lib/runtime/local-provider";
import { ModalRuntimeProvider } from "@/lib/runtime/modal-provider";
import type { RuntimeProvider } from "@/lib/runtime/types";

let cached: RuntimeProvider | null = null;

/**
 * Resolve the active RuntimeProvider.
 *
 * `local` runs everything in a directory on this machine and exists so the
 * whole product (API surface, UI, lifecycle) can be developed and tested
 * without a cloud backend. `daytona` is the real backend (one always-on
 * Runtime Computer per project); `modal` is the legacy workspace-per-sandbox
 * backend retained until the Daytona path is fully wired.
 */
export function getRuntimeProvider(): RuntimeProvider {
  if (cached) return cached;

  switch (providerName()) {
    case "daytona":
      cached = new DaytonaRuntimeProvider();
      break;
    case "modal":
      cached = new ModalRuntimeProvider();
      break;
    case "e2b":
      if (!e2bEnabled()) {
        throw new Error(
          "E2B is disabled. Set RUNTIME_ENABLE_E2B=true only after the pinned template passes real-sandbox acceptance.",
        );
      }
      cached = new E2BRuntimeProvider();
      break;
    default:
      cached = new LocalRuntimeProvider();
  }
  return cached;
}

/** Test seam: drop the memoized provider. */
export function resetRuntimeProvider(): void {
  cached = null;
}
