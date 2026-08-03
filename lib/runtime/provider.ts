import { providerName } from "@/lib/env";
import { LocalRuntimeProvider } from "@/lib/runtime/local-provider";
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
    // Loaded lazily so the Modal SDK and its credentials are never required
    // in local development.
    throw new Error(
      "Modal provider is not implemented yet (milestone M4). Set RUNTIME_PROVIDER=local.",
    );
  }

  cached = new LocalRuntimeProvider();
  return cached;
}

/** Test seam: drop the memoized provider. */
export function resetRuntimeProvider(): void {
  cached = null;
}
