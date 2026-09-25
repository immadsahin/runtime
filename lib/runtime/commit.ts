/**
 * Commit-from-UI core for the source-control panel: commit the worktree's
 * changes on its own branch, WITHOUT pushing (publish still owns commit+push+PR).
 *
 * The orchestration takes an injected {@link CommitIO} so it is unit-testable
 * with a fake provider and — because that interface exposes only `listChanged`
 * and `commit` — is *structurally* incapable of pushing. The route wires the
 * real provider methods into the IO.
 */

import type { ChangedFile } from "@/lib/runtime/types";

/** Max commit subject length; mirrors the publish route's title cap. */
export const MAX_COMMIT_SUMMARY = 256;

/** Validate the commit subject. Returns a user-facing reason, or null if OK. */
export function commitMessageError(summary: string): string | null {
  const trimmed = summary.trim();
  if (!trimmed) return "A commit summary is required.";
  if (trimmed.length > MAX_COMMIT_SUMMARY) {
    return `Keep the summary under ${MAX_COMMIT_SUMMARY} characters.`;
  }
  return null;
}

/** Assemble the git commit message from the panel's Summary + Description,
 *  using the conventional `subject\n\nbody` shape. */
export function buildCommitMessage(summary: string, description: string): string {
  const subject = summary.trim();
  const body = description.trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/** The only two operations commit-from-UI may perform — deliberately no push. */
export type CommitIO = {
  listChanged: () => Promise<ChangedFile[]>;
  commit: (message: string) => Promise<{ sha: string }>;
};

export type CommitOutcome =
  | { committed: true; sha: string }
  | { committed: false; sha: null };

/**
 * Commit the worktree's changes if there are any. A clean worktree is not an
 * error — it returns `committed: false` so the caller can report "nothing to
 * commit" rather than surfacing a git failure.
 */
export async function runCommit(io: CommitIO, message: string): Promise<CommitOutcome> {
  const changed = await io.listChanged();
  if (changed.length === 0) return { committed: false, sha: null };
  const { sha } = await io.commit(message);
  return { committed: true, sha };
}
