# Runtime v0

A single-user browser control plane for creating repository-centric Claude Code
workspaces. The browser coordinates work; provider implementations own the
actual worktree and process lifecycle.

## Milestones

- **M1:** Supabase-backed owner isolation for projects, workspaces, and jobs.
- **M2:** GitHub OAuth plus server-side repository synchronization.
- **M3:** Local workspaces. Create an isolated Git worktree from a synchronized
  project and observe its provisioning lifecycle in the browser.
- **M4:** Modal workspaces. The same lifecycle can create a disposable Modal
  Sandbox backed by a named persistent Modal Volume.
- **M5:** Resume, suspend, and permanently destroy workspaces through
  owner-gated browser controls. Suspension releases compute while keeping the
  worktree; destruction removes both compute and durable storage.

Claude jobs, logs, diffs, and pull requests intentionally come in later
milestones.

## Local setup

1. Copy `.env.example` to `.env.local` and complete the Supabase and GitHub
   owner settings.
2. Apply every SQL file in `supabase/migrations/` in filename order through
   the Supabase SQL editor (or use the Supabase CLI against your project).
3. Run `pnpm install` followed by `pnpm dev`.

`GITHUB_PAT` is server-only. It needs repository **Metadata: Read** to sync
projects and **Contents: Read** to create an M3 workspace from a private
repository. Keep it out of `NEXT_PUBLIC_*`, commits, and database rows.

## M3 local workspaces

After syncing a repository, open its project page and create a workspace. A
blank branch name produces a unique `runtime/...` branch; a supplied branch is
created from the repository default branch. The local provider stores files in
`$TMPDIR/runtime-local` unless `RUNTIME_LOCAL_ROOT` is configured. For a
deployment that must survive a host restart, set `RUNTIME_LOCAL_ROOT` to a
durable, app-private directory owned by the Runtime service account (mode 0700);
the temporary-directory default is for local development only.

## M4 Modal workspaces

Set `RUNTIME_PROVIDER=modal`, `MODAL_TOKEN_ID`, and `MODAL_TOKEN_SECRET` to
run the workspace lifecycle on Modal. Runtime creates a named Modal Volume per
workspace and mounts it at `/runtime`; the Volume retains the clone and
worktree after the 24-hour Modal Sandbox expires. The provider builds a Node
22 image with Git and Claude Code, creates an isolated worktree, installs
dependencies, and verifies both Git and Claude Code before reporting ready.

## M5 workspace lifecycle

The workspace detail page can suspend an active workspace, resume a suspended
workspace on fresh compute, or irreversibly destroy it. Lifecycle requests are
same-origin and owner-gated. Runtime atomically records `suspending`,
`resuming`, and `destroying` states before calling the provider so another
browser tab cannot run the same action twice.
