import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCommitMessage,
  commitMessageError,
  runCommit,
  MAX_COMMIT_SUMMARY,
  type CommitIO,
} from "@/lib/runtime/commit";
import type { ChangedFile } from "@/lib/runtime/types";

const file = (path: string): ChangedFile => ({
  path,
  status: "modified",
  additions: 0,
  deletions: 0,
});

test("commitMessageError rejects empty/whitespace and over-length summaries", () => {
  assert.equal(commitMessageError(""), "A commit summary is required.");
  assert.equal(commitMessageError("   "), "A commit summary is required.");
  assert.match(commitMessageError("x".repeat(MAX_COMMIT_SUMMARY + 1))!, /under \d+ characters/);
  assert.equal(commitMessageError("  fix the thing  "), null);
});

test("buildCommitMessage joins summary + description as subject/body and trims", () => {
  assert.equal(buildCommitMessage("subject", ""), "subject");
  assert.equal(buildCommitMessage("  subject  ", "   "), "subject");
  assert.equal(buildCommitMessage(" subject ", " body line "), "subject\n\nbody line");
});

test("runCommit commits when there are changes and returns the sha", async () => {
  let committedWith: string | null = null;
  const io: CommitIO = {
    listChanged: async () => [file("a.ts"), file("b.ts")],
    commit: async (message) => {
      committedWith = message;
      return { sha: "deadbeef" };
    },
  };

  const outcome = await runCommit(io, "do the thing");
  assert.deepEqual(outcome, { committed: true, sha: "deadbeef" });
  assert.equal(committedWith, "do the thing");
});

test("runCommit is a no-op on a clean worktree (not an error), never calling commit", async () => {
  let commitCalls = 0;
  const io: CommitIO = {
    listChanged: async () => [],
    commit: async () => {
      commitCalls += 1;
      return { sha: "should-not-happen" };
    },
  };

  const outcome = await runCommit(io, "nothing to do");
  assert.deepEqual(outcome, { committed: false, sha: null });
  assert.equal(commitCalls, 0);
});

test("runCommit propagates a commit failure (surfaced by the route as an error)", async () => {
  const io: CommitIO = {
    listChanged: async () => [file("a.ts")],
    commit: async () => {
      throw new Error("git commit exploded");
    },
  };
  await assert.rejects(runCommit(io, "msg"), /git commit exploded/);
});

test("CommitIO structurally cannot push — commit-only is guaranteed by the type", () => {
  // Compile-time guarantee documented as a runtime assertion: the IO surface is
  // exactly { listChanged, commit }. If a push method is ever added here, this
  // test (and the type) must be revisited.
  const io: CommitIO = { listChanged: async () => [], commit: async () => ({ sha: "x" }) };
  assert.deepEqual(Object.keys(io).sort(), ["commit", "listChanged"]);
});
