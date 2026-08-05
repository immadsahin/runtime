/**
 * Workspace Summary — the frozen contract mirror.
 *
 * The Summary is emitted live during a Workspace Session and snapshotted into
 * the manifest at archive. Its SHAPE is frozen here (M4 depends on it and so
 * does Mission Engine), but its PRODUCTION is owned by M3 — this file mirrors
 * the type/schema only, so foundations can validate the `summary.json` artifact
 * without implementing its emission. M3 converges on this shape.
 */
import { z } from "zod";

/**
 * Coarse lifecycle state carried on the Summary. Left as an open string here:
 * M3 pins the exact enum against the live Session states, and foundations must
 * not pre-empt that (nor touch `workspace_status`). Validation stays lenient so
 * a correct M3 value never fails the artifact round-trip.
 */
const WorkspaceSummaryState = z.string().min(1);

export const WorkspaceSummary = z
  .object({
    state: WorkspaceSummaryState,
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    /** seconds */
    duration: z.number().nonnegative(),
    lastActivity: z.string(),
    tokenUsage: z.record(z.string(), z.number().int().nonnegative()),
    changedFiles: z.number().int().nonnegative(),
    /** The file LIST (kept out of the manifest to keep the DB row small). */
    filesTouched: z.array(z.string()),
    commitCount: z.number().int().nonnegative(),
    lastAssistantMessage: z.string().nullable(),
  })
  .strict();

export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
