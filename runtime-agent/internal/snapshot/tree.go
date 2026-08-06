package snapshot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// buildBundle writes a git bundle of the worktree's full history (all refs) to
// dst. The bundle is the "committed" half of the tree; Restore clones from it.
func buildBundle(ctx context.Context, worktree, dst string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"bundle", "create", dst, "--all").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git bundle: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return dst, nil
}

// buildPatch writes a patch of the working-tree changes relative to HEAD so
// Restore can reconstruct exact WIP. Untracked (non-ignored) files are staged as
// intent-to-add first, so `git diff HEAD` emits them as new-file diffs and they
// round-trip through Restore's `git apply` — otherwise a restored worktree would
// silently drop any new-but-uncommitted file. The intent-to-add markers are then
// cleared so the index is left as we found it. An empty patch (no WIP) is valid.
//
// v0 limitation: binary untracked files can't round-trip through a text patch;
// they are not captured. `.gitignore`d files are excluded by design.
func buildPatch(ctx context.Context, worktree, dst string) (string, error) {
	// Best-effort: a failure here just means untracked files aren't captured.
	_ = exec.CommandContext(ctx, "git", "-C", worktree, "add", "-N", ".").Run()

	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "diff", "HEAD").Output()
	if err != nil {
		// A broken repo is the only real failure here; degrade to an empty patch
		// rather than aborting the whole archive over WIP capture.
		out = nil
	}

	// Undo intent-to-add so the archived worktree's index is unchanged.
	_ = exec.CommandContext(ctx, "git", "-C", worktree, "reset", "-q").Run()

	if err := os.WriteFile(dst, out, 0o644); err != nil {
		return "", fmt.Errorf("write patch: %w", err)
	}
	return dst, nil
}

// lastCommit returns the worktree's HEAD sha, or nil when there are no commits.
func lastCommit(ctx context.Context, worktree string) *string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "rev-parse", "HEAD").Output()
	if err != nil {
		return nil
	}
	sha := strings.TrimSpace(string(out))
	if sha == "" {
		return nil
	}
	return &sha
}
