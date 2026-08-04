import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { findOrCreatePullRequest } from "@/lib/github/client";

const realFetch = globalThis.fetch;

/** Stub global fetch with a handler that receives the request method. */
function setFetch(handler: (method: string) => Response): void {
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const method = (args[1]?.method ?? "GET").toString();
    return Promise.resolve(handler(method));
  }) as typeof fetch;
}

const PR_INPUT = {
  repoFullName: "owner/repo",
  headBranch: "runtime/x",
  baseBranch: "main",
  title: "t",
  body: "",
};

beforeEach(() => {
  process.env.GITHUB_PAT = "ghp_test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("findOrCreatePullRequest returns an existing open PR without creating one", async () => {
  let posts = 0;
  setFetch((method) => {
    if (method === "POST") {
      posts += 1;
      return new Response("{}", { status: 201 });
    }
    return new Response(JSON.stringify([{ number: 7, html_url: "https://gh/pr/7" }]), { status: 200 });
  });

  const pr = await findOrCreatePullRequest(PR_INPUT);
  assert.deepEqual(pr, { number: 7, url: "https://gh/pr/7" });
  assert.equal(posts, 0);
});

test("findOrCreatePullRequest creates a PR when none exists", async () => {
  setFetch((method) =>
    method === "POST"
      ? new Response(JSON.stringify({ number: 9, html_url: "https://gh/pr/9" }), { status: 201 })
      : new Response("[]", { status: 200 }),
  );

  const pr = await findOrCreatePullRequest(PR_INPUT);
  assert.deepEqual(pr, { number: 9, url: "https://gh/pr/9" });
});

test("findOrCreatePullRequest re-looks up the PR on a 422 (concurrent create)", async () => {
  let lookups = 0;
  setFetch((method) => {
    if (method === "POST") return new Response("{}", { status: 422 });
    lookups += 1;
    // First lookup empty (so we attempt create), second finds the racing PR.
    return new Response(
      JSON.stringify(lookups >= 2 ? [{ number: 5, html_url: "https://gh/pr/5" }] : []),
      { status: 200 },
    );
  });

  const pr = await findOrCreatePullRequest(PR_INPUT);
  assert.deepEqual(pr, { number: 5, url: "https://gh/pr/5" });
});
