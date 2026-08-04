import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addWorktree,
  cloneMirror,
  commitAll,
  fetchMirror,
  pushBranch,
  readFileDiff,
  type GitExec,
  type GitExecOptions,
} from "@/lib/runtime/git";

type Call = { argv: string[]; options?: GitExecOptions };

/** A GitExec that records every invocation and returns scripted stdout. */
function recorder(responses: string[] = []): { exec: GitExec; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GitExec = async (argv, options) => {
    calls.push({ argv, options });
    return { stdout: responses[i++] ?? "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

test("addWorktree builds an argv worktree command with -C", async () => {
  const { exec, calls } = recorder();
  await addWorktree(exec, {
    repoDir: "/r/repo",
    worktreePath: "/r/ws/x",
    branch: "feat/x",
    baseRef: "origin/main",
  });
  assert.deepEqual(calls[0].argv, [
    "git",
    "-C",
    "/r/repo",
    "worktree",
    "add",
    "-b",
    "feat/x",
    "/r/ws/x",
    "origin/main",
  ]);
});

test("pushBranch injects the token via env (never argv) and disables hooks", async () => {
  const { exec, calls } = recorder();
  await pushBranch(exec, {
    worktree: "/r/ws/x",
    repoFullName: "acme/app",
    branch: "feat/x",
    token: "ghs_secret",
  });
  // First call resets the remote; second pushes with auth.
  const push = calls[1];
  assert.ok(push.argv.includes("push"));
  assert.ok(push.argv.includes("core.hooksPath=/dev/null"));
  // The token must ride in the environment, not the argument vector.
  assert.equal(push.options?.env?.RUNTIME_GIT_TOKEN, "ghs_secret");
  assert.ok(!push.argv.some((a) => a.includes("ghs_secret")));
});

test("cloneMirror clones bare with auth env; fetchMirror prunes", async () => {
  const clone = recorder();
  await cloneMirror(clone.exec, {
    repoFullName: "acme/app",
    dir: "/r/repo.git",
    token: "t",
  });
  assert.ok(clone.calls[0].argv.includes("--bare"));
  assert.equal(clone.calls[0].options?.env?.RUNTIME_GIT_TOKEN, "t");

  const fetch = recorder();
  await fetchMirror(fetch.exec, { repoDir: "/r/repo.git", token: "t" });
  assert.deepEqual(fetch.calls[0].argv.slice(-3), ["fetch", "--prune", "origin"]);
});

test("commitAll sequences add -> commit -> rev-parse with author env", async () => {
  const { exec, calls } = recorder(["", "", "abc123\n"]);
  const result = await commitAll(exec, {
    worktree: "/r/ws/x",
    message: "msg",
    author: { name: "Ada", email: "ada@x.co" },
  });
  assert.equal(result.sha, "abc123");
  // argv is ["git", "-C", <worktree>, <subcommand>, ...].
  assert.deepEqual(
    calls.map((c) => c.argv[3]),
    ["add", "commit", "rev-parse"],
  );
  assert.equal(calls[1].options?.env?.GIT_AUTHOR_NAME, "Ada");
});

test("readFileDiff rejects unsafe paths before touching git", async () => {
  const { exec, calls } = recorder();
  await assert.rejects(
    readFileDiff(exec, { worktree: "/r/ws/x", path: "../etc/passwd" }),
    /Invalid changed file path/,
  );
  assert.equal(calls.length, 0);
});

test("readFileDiff rejects a path outside the change set", async () => {
  // status output lists only a.txt; requesting b.txt must fail.
  const { exec } = recorder(["M  a.txt\0"]);
  await assert.rejects(
    readFileDiff(exec, { worktree: "/r/ws/x", path: "b.txt" }),
    /not part of this workspace change set/,
  );
});
