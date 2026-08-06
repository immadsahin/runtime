package snapshot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/protocol"
)

// archivedRepo builds a repo on branch `feature` with a committed change plus
// tracked + untracked WIP, then returns a bundle and patch produced exactly as
// the archive flow would — the inputs a real Restore consumes.
func archivedRepo(t *testing.T) (bundle, patch string) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	run("init", "-q", "-b", "main")
	write("file.txt", "base\n")
	run("add", "-A")
	run("commit", "-q", "-m", "base")
	run("checkout", "-q", "-b", "feature")
	write("file.txt", "feature\n")
	if err := os.WriteFile(filepath.Join(dir, "logo.bin"), []byte{0x00, 0x01, 0x02, 0xff}, 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "feature")
	// WIP on top of the feature commit: a tracked text edit, a tracked BINARY
	// edit, and an untracked file — all must round-trip through Restore.
	write("file.txt", "feature wip\n")
	if err := os.WriteFile(filepath.Join(dir, "logo.bin"), []byte{0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f}, 0o644); err != nil {
		t.Fatal(err)
	}
	write("new.txt", "fresh\n")

	staging := t.TempDir()
	bundle = filepath.Join(staging, BundleName)
	patch = filepath.Join(staging, PatchName)
	if _, err := buildBundle(context.Background(), dir, bundle); err != nil {
		t.Fatalf("buildBundle: %v", err)
	}
	if _, err := buildPatch(context.Background(), dir, patch); err != nil {
		t.Fatalf("buildPatch: %v", err)
	}
	return bundle, patch
}

// artifactServer serves fixed bytes for each artifact path.
func artifactServer(t *testing.T, files map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		content, ok := files[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(content))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func bareMirror(t *testing.T) string {
	t.Helper()
	mirror := t.TempDir()
	if out, err := exec.Command("git", "init", "-q", "--bare", mirror).CombinedOutput(); err != nil {
		t.Fatalf("init mirror: %v: %s", err, out)
	}
	return mirror
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestMaterializeRebuildsWorktreeFromBundleAndPatch(t *testing.T) {
	bundle, patch := archivedRepo(t)

	// Serve the bundle/patch bytes + a conversation JSONL.
	bundleBytes := readFile(t, bundle)
	patchBytes := readFile(t, patch)
	conversation := `{"type":"assistant","uuid":"u1","message":{"role":"assistant","content":[]}}` + "\n"
	srv := artifactServer(t, map[string]string{
		"/bundle":       bundleBytes,
		"/patch":        patchBytes,
		"/conversation": conversation,
	})

	mirror := bareMirror(t)
	worktree := filepath.Join(t.TempDir(), "ws")
	convDest := filepath.Join(t.TempDir(), "projects", "slug", "sess.jsonl")

	err := Materialize(context.Background(), MaterializeInput{
		MirrorPath:       mirror,
		WorktreePath:     worktree,
		Branch:           "feature",
		ConversationDest: convDest,
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: srv.URL + "/bundle"},
			{Artifact: "patch", URL: srv.URL + "/patch"},
			{Artifact: "conversation", URL: srv.URL + "/conversation"},
		},
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}

	// Committed feature content + the applied tracked WIP.
	if got := readFile(t, filepath.Join(worktree, "file.txt")); got != "feature wip\n" {
		t.Fatalf("file.txt = %q, want %q", got, "feature wip\n")
	}
	// The untracked file was captured (intent-to-add) and restored via the patch.
	if got := readFile(t, filepath.Join(worktree, "new.txt")); got != "fresh\n" {
		t.Fatalf("new.txt = %q, want %q", got, "fresh\n")
	}
	// The tracked BINARY edit round-tripped through `git diff --binary` + apply.
	if got := readFile(t, filepath.Join(worktree, "logo.bin")); got != string([]byte{0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f}) {
		t.Fatalf("logo.bin binary WIP not restored: %x", got)
	}
	// The conversation JSONL was placed where `claude --continue` will find it.
	if got := readFile(t, convDest); got != conversation {
		t.Fatalf("conversation not placed: %q", got)
	}
}

func TestMaterializeIsIdempotent(t *testing.T) {
	bundle, patch := archivedRepo(t)
	srv := artifactServer(t, map[string]string{
		"/bundle": readFile(t, bundle),
		"/patch":  readFile(t, patch),
	})
	mirror := bareMirror(t)
	worktree := filepath.Join(t.TempDir(), "ws")
	in := MaterializeInput{
		MirrorPath:   mirror,
		WorktreePath: worktree,
		Branch:       "feature",
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: srv.URL + "/bundle"},
			{Artifact: "patch", URL: srv.URL + "/patch"},
		},
	}
	if err := Materialize(context.Background(), in); err != nil {
		t.Fatalf("first materialize: %v", err)
	}
	// A second restore over an existing worktree must converge, not fail.
	if err := Materialize(context.Background(), in); err != nil {
		t.Fatalf("second materialize: %v", err)
	}
	if got := readFile(t, filepath.Join(worktree, "file.txt")); got != "feature wip\n" {
		t.Fatalf("file.txt after re-restore = %q", got)
	}
}

func TestMaterializeRequiresBundleAndPatchURLs(t *testing.T) {
	err := Materialize(context.Background(), MaterializeInput{
		MirrorPath:   bareMirror(t),
		WorktreePath: filepath.Join(t.TempDir(), "ws"),
		Branch:       "feature",
		Downloads:    []protocol.RestoreDownload{{Artifact: "bundle", URL: "http://x/bundle"}},
	})
	if err == nil || !strings.Contains(err.Error(), "missing the patch") {
		t.Fatalf("expected missing-patch error, got %v", err)
	}
}

func TestMaterializeRequiresConversationWhenDestinationSet(t *testing.T) {
	bundle, patch := archivedRepo(t)
	srv := artifactServer(t, map[string]string{
		"/bundle": readFile(t, bundle),
		"/patch":  readFile(t, patch),
	})
	// ConversationDest is set but no conversation URL is supplied — restore must
	// fail closed rather than boot `claude --continue` with no session JSONL.
	err := Materialize(context.Background(), MaterializeInput{
		MirrorPath:       bareMirror(t),
		WorktreePath:     filepath.Join(t.TempDir(), "ws"),
		Branch:           "feature",
		ConversationDest: filepath.Join(t.TempDir(), "sess.jsonl"),
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: srv.URL + "/bundle"},
			{Artifact: "patch", URL: srv.URL + "/patch"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "missing the conversation") {
		t.Fatalf("expected missing-conversation error, got %v", err)
	}
}

func TestMaterializeFailsOnUnapplyablePatch(t *testing.T) {
	bundle, _ := archivedRepo(t)
	srv := artifactServer(t, map[string]string{
		"/bundle": readFile(t, bundle),
		// A patch that references content not present at HEAD → won't apply.
		"/patch": "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-nonexistent line\n+replacement\n",
	})
	err := Materialize(context.Background(), MaterializeInput{
		MirrorPath:   bareMirror(t),
		WorktreePath: filepath.Join(t.TempDir(), "ws"),
		Branch:       "feature",
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: srv.URL + "/bundle"},
			{Artifact: "patch", URL: srv.URL + "/patch"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "apply patch") {
		t.Fatalf("expected apply-patch failure (restore aborts), got %v", err)
	}
}
