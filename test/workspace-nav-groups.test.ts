import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNavGroups,
  fallbackProject,
} from "@/lib/nav/workspace-nav-groups";
import type { Project, Workspace } from "@/lib/runtime/types";

function project(id: string, name = id): Project {
  return {
    id,
    githubRepoId: 1,
    fullName: `acme/${name}`,
    owner: "acme",
    name,
    defaultBranch: "main",
    private: false,
    language: null,
    description: null,
    htmlUrl: `https://github.com/acme/${name}`,
    pushedAt: null,
    linearIssueIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function workspace(
  id: string,
  projectId: string,
  lastActiveAt: string | null,
): Workspace {
  return {
    id,
    projectId,
    provider: "daytona",
    status: "ready",
    phase: null,
    branch: `runtime/${id}`,
    baseBranch: "main",
    worktreePath: `/home/runtime/ws/${id}`,
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    lastActiveAt,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("groups workspaces under their project", () => {
  const groups = buildNavGroups(
    [project("p1"), project("p2")],
    [
      workspace("w1", "p1", "2026-02-01T00:00:00Z"),
      workspace("w2", "p1", "2026-02-02T00:00:00Z"),
      workspace("w3", "p2", "2026-01-15T00:00:00Z"),
    ],
  );

  assert.equal(groups.length, 2);
  assert.equal(groups[0].project.id, "p1");
  assert.deepEqual(
    groups[0].items.map((w) => w.id),
    ["w2", "w1"],
  );
  assert.equal(groups[1].project.id, "p2");
});

test("orders groups by their most-recent workspace", () => {
  const groups = buildNavGroups(
    [project("old"), project("new")],
    [
      workspace("a", "old", "2026-01-01T00:00:00Z"),
      workspace("b", "new", "2026-03-01T00:00:00Z"),
    ],
  );

  assert.deepEqual(
    groups.map((g) => g.project.id),
    ["new", "old"],
  );
});

test("projects without workspaces produce no group", () => {
  const groups = buildNavGroups(
    [project("p1"), project("empty")],
    [workspace("w1", "p1", "2026-02-01T00:00:00Z")],
  );

  assert.deepEqual(
    groups.map((g) => g.project.id),
    ["p1"],
  );
});

test("a workspace whose project is unlisted still appears with a placeholder", () => {
  // `listProjects` hides hidden repos, but their workspaces stay openable — the
  // nav must not drop them. Regression guard for the silent-filter bug.
  const groups = buildNavGroups(
    [project("visible")],
    [
      workspace("w1", "visible", "2026-02-01T00:00:00Z"),
      workspace("w2", "hidden-proj", "2026-02-05T00:00:00Z"),
    ],
  );

  assert.equal(groups.length, 2);
  const hidden = groups.find((g) => g.project.id === "hidden-proj");
  assert.ok(hidden, "hidden-project workspace must still be grouped");
  assert.deepEqual(hidden!.project, fallbackProject("hidden-proj"));
  assert.deepEqual(
    hidden!.items.map((w) => w.id),
    ["w2"],
  );
});

test("falls back to createdAt when lastActiveAt is null", () => {
  const groups = buildNavGroups(
    [project("p1")],
    [workspace("w1", "p1", null)],
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items[0].id, "w1");
});
