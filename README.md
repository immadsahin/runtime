# Runtime v0

A single-user browser control plane for creating repository-centric Claude Code
workspaces. The browser coordinates work; provider implementations own the
actual worktree and process lifecycle.

## Milestones

- **M1:** Supabase-backed owner isolation for projects, workspaces, and jobs.
- **M2:** GitHub OAuth plus server-side repository synchronization.
- **M3:** Local workspaces. Create an isolated Git worktree from a synchronized
  project and observe its provisioning lifecycle in the browser.

Modal-backed cloud workspaces, workspace suspension, Claude jobs, logs, diffs,
and pull requests intentionally come in later milestones.

## Local setup

1. Copy `.env.example` to `.env.local` and complete the Supabase and GitHub
   owner settings.
2. Apply `supabase/migrations/20260731090000_init.sql` through the Supabase SQL
   editor (or use the Supabase CLI against your project).
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
