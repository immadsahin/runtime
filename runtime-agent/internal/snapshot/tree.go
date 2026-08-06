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
// Restore can reconstruct exact WIP — including binary changes and untracked
// files. `--binary` serializes binary blobs so `git apply` can rebuild them.
// Untracked (non-ignored) files are staged intent-to-add so they appear as
// new-file diffs, then the intent-to-add markers are cleared for EXACTLY those
// paths — never a blanket reset, so any files the session had genuinely staged
// keep their index state. An empty patch (no WIP) is valid.
//
// `.gitignore`d files are excluded by design.
func buildPatch(ctx context.Context, worktree, dst string) (string, error) {
	// The untracked (non-ignored) files to fold in as new-file diffs.
	others := untrackedFiles(ctx, worktree)
	if len(others) > 0 {
		args := append([]string{"-C", worktree, "add", "-N", "--"}, others...)
		_ = exec.CommandContext(ctx, "git", args...).Run() // best-effort
	}

	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "diff", "HEAD", "--binary").Output()
	if err != nil {
		// A broken repo is the only real failure here; degrade to an empty patch
		// rather than aborting the whole archive over WIP capture.
		out = nil
	}

	// Undo intent-to-add for exactly the paths we added — leaving any pre-staged
	// tracked changes in the index untouched.
	if len(others) > 0 {
		args := append([]string{"-C", worktree, "reset", "-q", "--"}, others...)
		_ = exec.CommandContext(ctx, "git", args...).Run()
	}

	if err := os.WriteFile(dst, out, 0o644); err != nil {
		return "", fmt.Errorf("write patch: %w", err)
	}
	return dst, nil
}

// untrackedFiles lists the worktree's untracked, non-ignored files.
func untrackedFiles(ctx context.Context, worktree string) []string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"ls-files", "--others", "--exclude-standard", "-z").Output()
	if err != nil || len(out) == 0 {
		return nil
	}
	var files []string
	for _, name := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		if name != "" {
			files = append(files, name)
		}
	}
	return files
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
