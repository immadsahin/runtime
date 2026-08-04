import { NextResponse } from "next/server";

import { getRuntimeProvider } from "@/lib/runtime/provider";
import type { RuntimeProvider, Workspace } from "@/lib/runtime/types";

/**
 * Resolve the RuntimeProvider that owns a workspace's compute, or an
 * HTTP-shaped failure. Centralizes the two ways provider resolution fails —
 * "the configured provider could not be constructed" (503) and "the configured
 * provider is not the one this workspace runs on" (409) — that every compute
 * route (jobs, publish, lifecycle, terminal) would otherwise re-implement.
 */
export type ProviderResolution =
  | { ok: true; provider: RuntimeProvider }
  | { ok: false; status: 503 | 409; message: string };

export function resolveProvider(workspace: Workspace): ProviderResolution {
  let provider: RuntimeProvider;
  try {
    provider = getRuntimeProvider();
  } catch (error) {
    console.error(`Workspace ${workspace.id} provider is unavailable`, error);
    return {
      ok: false,
      status: 503,
      message: "The configured Runtime provider is not available.",
    };
  }
  if (provider.name !== workspace.provider) {
    return {
      ok: false,
      status: 409,
      message: `Configure the ${workspace.provider} provider before managing this workspace.`,
    };
  }
  return { ok: true, provider };
}

/** Turn a failed {@link resolveProvider} result into its JSON error response. */
export function providerErrorResponse(
  resolution: Extract<ProviderResolution, { ok: false }>,
): NextResponse {
  return NextResponse.json({ error: resolution.message }, { status: resolution.status });
}
