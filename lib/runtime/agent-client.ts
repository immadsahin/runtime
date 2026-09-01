/**
 * Typed client for the runtime-agent, used by the Next control plane. Control
 * calls go server-to-server over the standard Daytona preview URL (with the
 * preview-token header + a Runtime token); the browser terminal connects
 * directly to the signed preview URL, so `ptyUrl` just builds that address.
 *
 * Every response is validated against the frozen protocol — no ad-hoc JSON.
 */

import {
  ArchiveWorkspaceRequest,
  CreateWorkspaceRequest,
  ErrorResponse,
  RestoreWorkspaceRequest,
  type RuntimeTokenClaims,
  WorkspaceSummary,
} from "@/lib/runtime/agent-protocol";
import { mintRuntimeToken } from "@/lib/runtime/runtime-token";
import {
  parseManifest,
  type SnapshotManifest,
} from "@/lib/runtime/snapshot/manifest";

/** Everything needed to reach one Runtime Computer's agent. */
export type AgentTarget = {
  /** Standard preview URL base for control calls, e.g.
   *  `https://8080-<sandboxId>.daytonaproxy01.net`. */
  controlBaseUrl: string;
  /** Daytona preview token for the control base (sent as a header). */
  daytonaPreviewToken: string;
  /** Signed preview URL base for the browser WS (token already in the host). */
  signedWsBaseUrl: string;
  /** Per-computer Runtime secret used to mint Runtime tokens. */
  secret: string;
};

/** The authorized identity for a workspace connection (exp is filled by mint). */
export type WorkspaceIdentity = Omit<RuntimeTokenClaims, "exp">;

type FetchFn = typeof fetch;

export class AgentClient {
  private readonly target: AgentTarget;
  private readonly fetchFn: FetchFn;

  constructor(target: AgentTarget, fetchFn: FetchFn = fetch) {
    this.target = target;
    this.fetchFn = fetchFn;
  }

  async createWorkspace(
    req: CreateWorkspaceRequest,
    identity: WorkspaceIdentity,
  ): Promise<{ worktree: string }> {
    const body = CreateWorkspaceRequest.parse(req);
    return this.post("/workspaces", identity, body) as Promise<{
      worktree: string;
    }>;
  }

  startWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/start`, identity);
  }

  stopWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/stop`, identity);
  }

  /**
   * Deliver a user prompt to the workspace's agent session (jcode engine). The
   * reply streams back on the Conversation SSE; this just starts the turn.
   */
  sendMessage(identity: WorkspaceIdentity, content: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/message`, identity, {
      content,
    });
  }

  resumeWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/resume`, identity);
  }

  /**
   * Archive the workspace: the agent produces the Snapshot artifacts and uploads
   * them through the supplied signed URLs (manifest last), returning the manifest
   * it assembled. Validated against the manifest schema — the same contract the
   * db row caches — so a malformed manifest fails here, not downstream.
   */
  async archiveWorkspace(
    identity: WorkspaceIdentity,
    req: ArchiveWorkspaceRequest,
  ): Promise<SnapshotManifest> {
    const body = ArchiveWorkspaceRequest.parse(req);
    const raw = await this.post(
      `/workspaces/${identity.workspaceId}/archive`,
      identity,
      body,
    );
    return parseManifest(raw);
  }

  /**
   * Restore an archived workspace: the agent downloads the tree + conversation
   * via the supplied signed URLs, rebuilds and verifies the worktree, and
   * relaunches Claude with `--continue`. Rejects (agent 500) if verification
   * fails — Claude is not booted into a broken restore.
   */
  async restoreWorkspace(
    identity: WorkspaceIdentity,
    req: RestoreWorkspaceRequest,
  ): Promise<unknown> {
    const body = RestoreWorkspaceRequest.parse(req);
    return this.post(`/workspaces/${identity.workspaceId}/restore`, identity, body);
  }

  destroyWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/destroy`, identity);
  }

  /**
   * Fetch the current WorkspaceSummary for a workspace. Cheap enough for
   * Mission Engine's polling cadence; the agent maintains the event-driven
   * fields in memory and shells out to git for the rest at request time.
   */
  async workspaceSummary(identity: WorkspaceIdentity): Promise<WorkspaceSummary> {
    const raw = await this.get(`/workspaces/${identity.workspaceId}/summary`, identity);
    return WorkspaceSummary.parse(raw);
  }

  /**
   * The `wss://` URL the browser opens for the live terminal: the signed
   * Daytona preview host (token in the subdomain, so no headers) plus a short
   * Runtime token the agent verifies.
   */
  ptyUrl(identity: WorkspaceIdentity): string {
    const base = this.target.signedWsBaseUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/pty?token=${encodeURIComponent(token)}`;
  }

  /**
   * The `https://` URL the browser opens for the Conversation event stream
   * (SSE). Same signed host as {@link ptyUrl}, same short-lived Runtime token,
   * but plain HTTP because SSE requires a normal fetch — not a WS upgrade.
   *
   * EventSource resends `Last-Event-ID` automatically on transient reconnects;
   * programmatic reconnects (after token refresh) should append
   * `?lastEventId=<seq>` — the agent honors either.
   */
  eventsUrl(identity: WorkspaceIdentity): string {
    const base = this.target.signedWsBaseUrl.replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/events?token=${encodeURIComponent(token)}`;
  }

  private async post(
    path: string,
    identity: WorkspaceIdentity,
    body?: unknown,
  ): Promise<unknown> {
    return this.request("POST", path, identity, body);
  }

  private async get(path: string, identity: WorkspaceIdentity): Promise<unknown> {
    return this.request("GET", path, identity);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    identity: WorkspaceIdentity,
    body?: unknown,
  ): Promise<unknown> {
    const token = mintRuntimeToken(identity, this.target.secret);
    const response = await this.fetchFn(
      `${this.target.controlBaseUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          ...(body !== undefined && { "content-type": "application/json" }),
          authorization: `Bearer ${token}`,
          "x-daytona-preview-token": this.target.daytonaPreviewToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );

    const text = await response.text();
    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(safeJson(text));
      throw new Error(
        parsed.success
          ? `agent ${parsed.data.error.code}: ${parsed.data.error.message}`
          : `agent request failed (${response.status})`,
      );
    }
    return safeJson(text);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
