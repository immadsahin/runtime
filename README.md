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
- **M6:** Run one detached Claude Code task per active workspace. Provider-owned
  completion records keep job state recoverable after a page refresh or request
  ends.
- **M7:** Stream resumable, redacted Claude logs to the workspace page using
  server-sent events.
- **M8:** Review the current changed-file list and bounded, text-only diffs
  before publishing.
- **M9:** Commit the worktree as the authenticated GitHub owner, then push its
  branch and create one idempotent pull request.

## Local setup

1. Copy `.env.example` to `.env.local` and complete the Supabase and GitHub
   owner settings.
2. Apply every SQL file in `supabase/migrations/` in filename order through
   the Supabase SQL editor (or use the Supabase CLI against your project).
3. Run `pnpm install` followed by `pnpm dev`.

`GITHUB_PAT` is server-only. It needs repository **Metadata: Read** to sync
projects, **Contents: Read and write** to clone private repositories and push
workspace branches, and **Pull requests: Read and write** to find or create
M9 pull requests. The token must belong to the configured Runtime owner.
Keep it out of `NEXT_PUBLIC_*`, commits, database rows, and repository setup
scripts.

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

## M6–M9 Claude, review, and publishing workflow

After a workspace is ready, enter a task in **Claude Code**. Runtime creates a
durable queued job, starts Claude as a detached provider process, and records
the log and completion paths before returning control to the browser. Only one
queued or running job is allowed per workspace. Its terminal status is
reconciled from a provider-owned result record, so refreshing the page does
not abandon a completed job.

The log panel reconnects with byte offsets through an owner-scoped SSE endpoint.
Runtime redacts configured Claude credentials before text reaches the browser.
The Claude child receives only `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`; it never receives the GitHub token.

Use **Changes** to inspect uncommitted files. Runtime lists only the active
worktree's Git changes and serves a capped, literal-pathspec diff for a file
selected from that list. It rejects traversal, Git pathspec magic, and
unexpected provider log/result paths.

Use **Publish** only after the job is finished. Runtime confirms the configured
PAT still belongs to the signed-in owner, commits all current worktree changes
with that GitHub identity, pushes only the persisted workspace branch with a
short-lived credential scope, and creates one pull request. A persisted record
plus an existing-open-PR lookup makes retries idempotent. No GitHub or Claude
credential is stored in Supabase or exposed to the browser.

Apply migrations in order, including
`20260804090000_jobs_and_pull_requests.sql`, before using M6–M9. Run
`pnpm check`, `pnpm build`, and `./scripts/verify-migrations.sh` before
deployment. The local provider is appropriate only when `RUNTIME_LOCAL_ROOT`
is durable and private; production deployments should use a persistent Modal
Volume with server-only Modal credentials.
