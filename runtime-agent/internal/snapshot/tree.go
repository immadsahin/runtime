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

// buildPatch writes a patch of the tracked working-tree changes (staged and
// unstaged) relative to HEAD. An empty patch (no WIP) is valid and expected.
//
// v0 limitation: untracked files are NOT captured (`git diff HEAD` omits them).
// Restore therefore reconstructs committed history + tracked WIP; capturing
// untracked files is deferred with the rest of Restore (a later slice).
func buildPatch(ctx context.Context, worktree, dst string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", worktree, "diff", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		// A broken repo is the only real failure here; degrade to an empty patch
		// rather than aborting the whole archive over WIP capture.
		out = nil
	}
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
