/**
 * Typed client for the runtime-agent, used by the Next control plane. Control
 * calls go server-to-server over the standard Daytona preview URL (with the
 * preview-token header + a Runtime token); the browser terminal connects
 * directly to the signed preview URL, so `ptyUrl` just builds that address.
 *
 * Every response is validated against the frozen protocol — no ad-hoc JSON.
 */

import {
  CreateWorkspaceRequest,
  ErrorResponse,
  type RuntimeTokenClaims,
} from "@/lib/runtime/agent-protocol";
import { mintRuntimeToken } from "@/lib/runtime/runtime-token";

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

  archiveWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/archive`, identity);
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

  private async post(
    path: string,
    identity: WorkspaceIdentity,
    body?: unknown,
  ): Promise<unknown> {
    const token = mintRuntimeToken(identity, this.target.secret);
    const response = await this.fetchFn(
      `${this.target.controlBaseUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
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
