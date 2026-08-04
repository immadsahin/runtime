import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClient, type AgentTarget } from "@/lib/runtime/agent-client";
import { verifyRuntimeToken } from "@/lib/runtime/runtime-token";

const target: AgentTarget = {
  controlBaseUrl: "https://8080-sbx.daytonaproxy01.net",
  daytonaPreviewToken: "dt-preview-token",
  signedWsBaseUrl: "https://8080-signed.daytonaproxy01.net",
  secret: "computer-secret",
};

const identity = {
  workspaceId: "ws-1",
  projectId: "p-1",
  computerId: "c-1",
  userId: "u-1",
};

test("createWorkspace posts a valid body with a verifiable Runtime token", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ worktree: "/home/runtime/ws/ws-1" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  const out = await client.createWorkspace(
    { workspaceId: "ws-1", repoFullName: "acme/app", branch: "feat/x", baseBranch: "main" },
    identity,
  );

  assert.equal(out.worktree, "/home/runtime/ws/ws-1");
  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces");
  const headers = seenHeaders;
  // The Daytona preview header and a valid Runtime token must both be present.
  assert.equal(headers["x-daytona-preview-token"], "dt-preview-token");
  const bearer = headers["authorization"].replace("Bearer ", "");
  assert.equal(verifyRuntimeToken(bearer, target.secret).workspaceId, "ws-1");
});

test("a non-2xx error envelope is surfaced as a typed error", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ error: { code: "WORKSPACE_NOT_FOUND", message: "gone" } }),
      { status: 404 },
    )) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(
    () => client.startWorkspace(identity),
    /WORKSPACE_NOT_FOUND: gone/,
  );
});

test("ptyUrl builds a wss signed-preview URL carrying a Runtime token", () => {
  const client = new AgentClient(target);
  const url = new URL(client.ptyUrl(identity));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "8080-signed.daytonaproxy01.net");
  assert.equal(url.pathname, "/pty");
  assert.equal(
    verifyRuntimeToken(url.searchParams.get("token")!, target.secret).workspaceId,
    "ws-1",
  );
});
