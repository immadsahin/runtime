import { providerName } from "@/lib/env";
import { LocalRuntimeProvider } from "@/lib/runtime/local-provider";
import { ModalRuntimeProvider } from "@/lib/runtime/modal-provider";
import type { RuntimeProvider } from "@/lib/runtime/types";

let cached: RuntimeProvider | null = null;

/**
 * Resolve the active RuntimeProvider.
 *
 * `local` runs everything in a directory on this machine and exists so the
 * whole product (API surface, UI, lifecycle) can be developed and tested
 * without Modal. `modal` is the real backend.
 */
export function getRuntimeProvider(): RuntimeProvider {
  if (cached) return cached;

  if (providerName() === "modal") {
    cached = new ModalRuntimeProvider();
    return cached;
  }

  cached = new LocalRuntimeProvider();
  return cached;
}

/** Test seam: drop the memoized provider. */
export function resetRuntimeProvider(): void {
  cached = null;
}
