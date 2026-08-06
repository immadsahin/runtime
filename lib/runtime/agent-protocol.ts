/**
 * FROZEN wire contract between the Next control plane, the browser, and the Go
 * runtime-agent. This is the single source of truth: everything crossing the
 * boundary is validated against these zod schemas — no ad-hoc JSON.
 *
 * The agent (Go) mirrors these shapes as structs. Golden fixtures in
 * `agent-protocol.fixtures.json` are validated by BOTH sides in CI so the two
 * languages can never silently drift.
 *
 * See docs/architecture/protocol.md for the prose description.
 */

import { z } from "zod";

import {
  SNAPSHOT_ARTIFACTS,
  type SnapshotArtifact,
} from "@/lib/runtime/snapshot/manifest";

// ---------------------------------------------------------------------------
// Auth — the short-lived Runtime token the agent verifies on every connection.
// ---------------------------------------------------------------------------

export const RuntimeTokenClaims = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  computerId: z.string().min(1),
  userId: z.string().min(1),
  /** Unix seconds. Minted with a 5-minute TTL; verified at connect time. */
  exp: z.number().int().positive(),
});
export type RuntimeTokenClaims = z.infer<typeof RuntimeTokenClaims>;

// ---------------------------------------------------------------------------
// PTY socket (WS /pty) — bidirectional terminal frames.
// ---------------------------------------------------------------------------

export const PtyClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("input"), data: z.string() }),
  z.object({
    t: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessage>;

export const PtyServerMessage = z.discriminatedUnion("t", [
  // Coalesced terminal output (already redacted). seq is monotonic per socket.
  z.object({ t: z.literal("output"), data: z.string(), seq: z.number().int().nonnegative() }),
  // Whether this connection holds the keyboard (one writer, others read-only).
  z.object({ t: z.literal("role"), writer: z.boolean() }),
  // The Claude/PTY process exited; the UI offers resume.
  z.object({ t: z.literal("exit"), code: z.number().int() }),
  z.object({ t: z.literal("pong") }),
]);
export type PtyServerMessage = z.infer<typeof PtyServerMessage>;

// ---------------------------------------------------------------------------
// Control API (HTTP, Next -> agent). Requests + a stable error envelope.
// ---------------------------------------------------------------------------

export const CreateWorkspaceRequest = z.object({
  workspaceId: z.string().min(1),
  repoFullName: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

/** start/stop/archive/restore/delete all address one workspace by id. */
export const WorkspaceActionRequest = z.object({
  workspaceId: z.string().min(1),
});
export type WorkspaceActionRequest = z.infer<typeof WorkspaceActionRequest>;

/** The six Snapshot artifact keys (archive covers all; restore reads a subset). */
const ARCHIVE_ARTIFACTS = Object.keys(SNAPSHOT_ARTIFACTS) as [
  SnapshotArtifact,
  ...SnapshotArtifact[],
];
const RESTORE_ARTIFACTS = ["bundle", "patch", "conversation"] as const;

/** True when `got` is exactly `want` as a set — no missing, extra, or dup keys. */
function coversExactly(got: string[], want: readonly string[]): boolean {
  const set = new Set(got);
  return (
    got.length === want.length &&
    set.size === want.length &&
    want.every((k) => set.has(k))
  );
}

/**
 * One signed upload URL the control plane mints for a Snapshot artifact. The
 * agent PUTs that artifact's bytes to the URL — it never holds bucket
 * credentials (M4 open decision #1). `artifact` is a key of SNAPSHOT_ARTIFACTS.
 */
export const ArchiveUpload = z.object({
  artifact: z.enum(ARCHIVE_ARTIFACTS),
  url: z.string().url(),
});
export type ArchiveUpload = z.infer<typeof ArchiveUpload>;

/**
 * Archive-time inputs the agent needs to PRODUCE a Snapshot: the logical archive
 * timestamp (echoed verbatim into the manifest so it matches the storage prefix
 * Next derived from it) and a signed upload URL for EVERY artifact — requiring
 * the full set here prevents an incomplete Snapshot (a manifest pointing at
 * missing objects) from ever being persisted as an archived workspace.
 */
export const ArchiveWorkspaceRequest = z
  .object({
    archivedAt: z.string().min(1),
    uploads: z.array(ArchiveUpload),
  })
  .refine((v) => coversExactly(v.uploads.map((u) => u.artifact), ARCHIVE_ARTIFACTS), {
    message: "archive uploads must cover exactly the six Snapshot artifacts",
    path: ["uploads"],
  });
export type ArchiveWorkspaceRequest = z.infer<typeof ArchiveWorkspaceRequest>;

/** One signed download URL for a Snapshot artifact the agent reads at Restore. */
export const RestoreDownload = z.object({
  artifact: z.enum(RESTORE_ARTIFACTS),
  url: z.string().url(),
});
export type RestoreDownload = z.infer<typeof RestoreDownload>;

/**
 * Inputs to rebuild an archived Session on a (possibly fresh) box: the branch to
 * check out, the Claude sessionId to place the conversation under (so
 * `claude --continue` resumes the exact session), and download URLs for EVERY
 * artifact Restore needs — `bundle`, `patch`, and `conversation`. Requiring the
 * full set prevents a false-success restore that can't resume the session.
 */
export const RestoreWorkspaceRequest = z
  .object({
    branch: z.string().min(1),
    baseBranch: z.string().optional(),
    sessionId: z.string().min(1).nullable(),
    downloads: z.array(RestoreDownload),
  })
  .refine((v) => coversExactly(v.downloads.map((d) => d.artifact), RESTORE_ARTIFACTS), {
    message: "restore downloads must cover exactly bundle, patch, and conversation",
    path: ["downloads"],
  });
export type RestoreWorkspaceRequest = z.infer<typeof RestoreWorkspaceRequest>;

export const ErrorCode = z.enum([
  "WORKSPACE_NOT_FOUND",
  "UNAUTHORIZED",
  "AGENT_UNREACHABLE",
  "INVALID_REQUEST",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ---------------------------------------------------------------------------
// Workspace Summary — the canonical, cross-milestone summary of a Workspace
// Session. Frozen jointly with docs/architecture/m4-plan.md (the M4 Snapshot
// manifest embeds this same shape). Emitted live during a Session and
// snapshotted into the archive manifest at teardown.
//
// M3 owns the type definition (this module + the Go equivalent in
// runtime-agent/internal/protocol). Every other consumer (Mission Engine,
// M4 archive/restore, the Runtime SDK, notifications, analytics) imports or
// mirrors the shape — they do not redefine it.
// ---------------------------------------------------------------------------

export const WorkspaceState = z.enum([
  "starting",
  "running",
  "exited",
  "archived",
  "degraded",
]);
export type WorkspaceState = z.infer<typeof WorkspaceState>;

export const WorkspaceSummary = z.object({
  state: WorkspaceState,
  /** RFC3339 UTC — when the session first started. */
  startedAt: z.string(),
  /** RFC3339 UTC when the session ended, or null while it's still running. */
  endedAt: z.string().nullable(),
  /** Wall-clock (endedAt || now) − startedAt, in whole seconds. */
  duration: z.number().int().nonnegative(),
  /** RFC3339 UTC of the most recent activity we've observed (message, tool result, …). */
  lastActivity: z.string(),
  /** Cumulative token usage across all assistant turns in this session.
   *  Numeric-only by design (interoperable with M4's placeholder validator
   *  and Mission Engine's expected shape); `service_tier` stays on the
   *  standalone `TokenUsage` event where per-turn detail belongs. */
  tokenUsage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
  }),
  /** Count of paths with any diff (staged + unstaged + untracked). */
  changedFiles: z.number().int().nonnegative(),
  /** Sorted union of paths this session has ever touched (committed or WIP). */
  filesTouched: z.array(z.string()),
  /** Commits made on this workspace's branch relative to the base branch. */
  commitCount: z.number().int().nonnegative(),
  /** The most recent assistant `text` content block, or null if none yet. */
  lastAssistantMessage: z.string().nullable(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

// ---------------------------------------------------------------------------
// Session attachment — the browser's handle to one Workspace Session. Returned
// by POST /api/workspaces/[id]/session. Each URL already contains the short-
// lived Runtime token (5-min TTL); refresh by re-calling the endpoint on close.
// See docs/architecture/session-contract.md.
// ---------------------------------------------------------------------------

export const SessionUrls = z.object({
  ptyUrl: z.string().url(),
  eventsUrl: z.string().url().optional(),
  /** Snapshot of the Workspace Summary at attach time; polled at
   *  `GET /api/workspaces/[id]/summary` for updates. */
  summary: WorkspaceSummary.optional(),
});
export type SessionUrls = z.infer<typeof SessionUrls>;

// ---------------------------------------------------------------------------
// Conversation events — derived by the agent from Claude's session JSONL,
// NOT parsed from the PTY. Grounded in the real schema (Spike 3/4).
// ---------------------------------------------------------------------------

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking") }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ type: z.literal("tool_result"), toolUseId: z.string(), content: z.unknown() }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const ConversationMessage = z.object({
  t: z.literal("message"),
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  role: z.enum(["user", "assistant"]),
  timestamp: z.string(),
  content: z.array(ContentBlock),
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

export const TokenUsage = z.object({
  t: z.literal("usage"),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const WorkspaceStateChanged = z.object({
  t: z.literal("state"),
  workspaceId: z.string(),
  state: z.enum(["starting", "running", "exited", "archived", "degraded"]),
});
export type WorkspaceStateChanged = z.infer<typeof WorkspaceStateChanged>;

/** Everything the agent pushes on the conversation/event channel. */
export const AgentEvent = z.discriminatedUnion("t", [
  ConversationMessage,
  TokenUsage,
  WorkspaceStateChanged,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

// ---------------------------------------------------------------------------
// Fixture registry — maps a schema name to its zod schema, so tests (and the
// Go side, by name) can validate the shared golden fixtures.
// ---------------------------------------------------------------------------

export const PROTOCOL_SCHEMAS = {
  RuntimeTokenClaims,
  PtyClientMessage,
  PtyServerMessage,
  CreateWorkspaceRequest,
  WorkspaceActionRequest,
  ArchiveWorkspaceRequest,
  RestoreWorkspaceRequest,
  ErrorResponse,
  SessionUrls,
  WorkspaceSummary,
  ConversationMessage,
  TokenUsage,
  WorkspaceStateChanged,
} as const;

export type ProtocolSchemaName = keyof typeof PROTOCOL_SCHEMAS;
