import type { Owner } from "@/lib/auth/owner";
import { optionalEnv } from "@/lib/env";
import type { Project, Workspace } from "@/lib/runtime/types";

/**
 * Dev-only escape hatch. When `RUNTIME_DEV_NO_SUPABASE=1` the control plane
 * runs on the in-memory fixtures below and a synthetic owner, so the UI is
 * browsable with NO Supabase project, NO auth provider, and NO database.
 *
 * Scope: READ paths return these fixtures; WRITE paths (create/update) still
 * hit Supabase and will fail loudly. This mode is for looking at and clicking
 * through the UI, not for exercising provisioning.
 *
 * SECURITY: this disables authentication entirely. It is read from the
 * environment and must NEVER be set in a deployed/production environment. The
 * flag is checked at every call site rather than assumed, and the produced
 * owner has no real identity.
 */
export function devNoSupabase(): boolean {
  return optionalEnv("RUNTIME_DEV_NO_SUPABASE") === "1";
}

/** The synthetic signed-in owner used in dev-no-supabase mode. */
export const DEV_OWNER: Owner = {
  id: "00000000-0000-0000-0000-000000000000",
  githubLogin: "dev",
  email: "dev@localhost",
  avatarUrl: null,
};

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEV_PROJECTS: Project[] = [
  {
    id: "proj-runtime",
    githubRepoId: 1,
    // A REAL repo the GITHUB_PAT can clone, so dev-create can actually provision.
    fullName: "immadsahin/runtime",
    owner: "immadsahin",
    name: "runtime",
    defaultBranch: "main",
    private: false,
    language: "TypeScript",
    description: "Cloud coding-agent control plane (this repo).",
    htmlUrl: "https://github.com/immadsahin/runtime",
    pushedAt: ago(2 * HOUR),
    linearIssueIds: [],
    createdAt: ago(30 * DAY),
    updatedAt: ago(2 * HOUR),
  },
  {
    id: "proj-web",
    githubRepoId: 2,
    fullName: "dev/web",
    owner: "dev",
    name: "web",
    defaultBranch: "main",
    private: false,
    language: "TypeScript",
    description: "Marketing site.",
    htmlUrl: "https://github.com/dev/web",
    pushedAt: ago(3 * DAY),
    linearIssueIds: [],
    createdAt: ago(60 * DAY),
    updatedAt: ago(3 * DAY),
  },
];

/** Builds a fixture workspace, defaulting the many nullable handles. */
function devWorkspace(overrides: Partial<Workspace> & Pick<Workspace, "id" | "projectId" | "branch">): Workspace {
  return {
    provider: "daytona",
    status: "idle",
    phase: null,
    baseBranch: "main",
    worktreePath: `/workspaces/${overrides.branch}`,
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: ago(DAY),
    updatedAt: ago(HOUR),
    ...overrides,
  };
}

export const DEV_WORKSPACES: Workspace[] = [
  devWorkspace({
    id: "ws-auth",
    projectId: "proj-runtime",
    branch: "feat/jcode-engine",
    status: "ready",
    lastActiveAt: ago(20 * MIN),
  }),
  devWorkspace({
    id: "ws-idle",
    projectId: "proj-runtime",
    branch: "fix/pty-reconnect",
    status: "idle",
    lastActiveAt: ago(28 * HOUR),
  }),
  devWorkspace({
    id: "ws-web",
    projectId: "proj-web",
    branch: "chore/copy-tweaks",
    status: "idle",
    lastActiveAt: ago(4 * DAY),
  }),
];
