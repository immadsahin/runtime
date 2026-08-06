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

test("archiveWorkspace posts the archive body and parses the manifest", async () => {
  const manifest = {
    version: 1,
    workspaceId: "ws-1",
    runtimeVersion: "dev",
    claudeVersion: "claude-code-1.2.3",
    sessionId: "sess-1",
    conversation: "conversation.jsonl",
    cast: "session.cast",
    tree: { kind: "git-bundle+patch", bundle: "worktree.bundle", patch: "uncommitted.patch" },
    summary: "summary.json",
    checksums: {},
    sizes: {},
    startedAt: "2026-08-06T00:00:00Z",
    archivedAt: "2026-08-06T00:05:00Z",
    lastCommit: null,
    lastMessage: null,
    tokenUsage: {},
    changedFiles: 0,
  };

  let seenUrl = "";
  let seenBody: unknown = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify(manifest), { status: 200 });
  }) as unknown as typeof fetch;

  const uploads = (["conversation", "cast", "bundle", "patch", "summary", "manifest"] as const).map(
    (artifact) => ({ artifact, url: `https://storage.example/upload/${artifact}?token=t` }),
  );
  const client = new AgentClient(target, fakeFetch);
  const out = await client.archiveWorkspace(identity, {
    archivedAt: "2026-08-06T00:05:00Z",
    uploads,
  });

  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/archive");
  assert.deepEqual(seenBody, { archivedAt: "2026-08-06T00:05:00Z", uploads });
  assert.equal(out.workspaceId, "ws-1");
  assert.equal(out.tree.kind, "git-bundle+patch");
});

test("archiveWorkspace rejects a request missing an artifact upload", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(() =>
    client.archiveWorkspace(identity, {
      archivedAt: "2026-08-06T00:05:00Z",
      uploads: [{ artifact: "manifest", url: "https://storage.example/m?token=t" }],
    }),
  );
  assert.equal(called, false);
});

test("archiveWorkspace rejects a malformed manifest response", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ version: 1, workspaceId: "ws-1" }), {
      status: 200,
    })) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(() =>
    client.archiveWorkspace(identity, {
      archivedAt: "2026-08-06T00:05:00Z",
      uploads: (["conversation", "cast", "bundle", "patch", "summary", "manifest"] as const).map(
        (artifact) => ({ artifact, url: `https://storage.example/${artifact}?token=t` }),
      ),
    }),
  );
});

test("restoreWorkspace posts branch, sessionId, and download URLs", async () => {
  let seenUrl = "";
  let seenBody: unknown = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ result: "ws-1" }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  await client.restoreWorkspace(identity, {
    branch: "feat/x",
    baseBranch: "main",
    sessionId: "sess-1",
    downloads: [
      { artifact: "bundle", url: "https://storage.example/b?token=t" },
      { artifact: "patch", url: "https://storage.example/p?token=t" },
      { artifact: "conversation", url: "https://storage.example/c?token=t" },
    ],
  });

  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/restore");
  assert.deepEqual(seenBody, {
    branch: "feat/x",
    baseBranch: "main",
    sessionId: "sess-1",
    downloads: [
      { artifact: "bundle", url: "https://storage.example/b?token=t" },
      { artifact: "patch", url: "https://storage.example/p?token=t" },
      { artifact: "conversation", url: "https://storage.example/c?token=t" },
    ],
  });
});

test("restoreWorkspace rejects an invalid request body before calling the agent", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(() =>
    client.restoreWorkspace(identity, {
      branch: "",
      sessionId: "s",
      downloads: [],
    }),
  );
  assert.equal(called, false);
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
