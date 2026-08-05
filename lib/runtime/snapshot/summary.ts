/**
 * Workspace Summary — canonical re-export.
 *
 * M3 (`lib/runtime/agent-protocol.ts`) owns the definition; this module used
 * to hold a placeholder mirror so M4-foundations could validate the
 * `summary.json` artifact before M3 pinned the shape. That's now converged:
 * one canonical schema, both used by M3 (live emission on the agent) and by
 * M4 (Snapshot artifact validation). New downstream code should import from
 * `@/lib/runtime/agent-protocol` directly.
 */
export { WorkspaceSummary } from "@/lib/runtime/agent-protocol";
