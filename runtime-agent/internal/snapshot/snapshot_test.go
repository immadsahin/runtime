package snapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"runtime-agent/internal/protocol"
)

// uploadServer records every PUT body keyed by artifact, and the order in which
// they arrived — so tests can assert the manifest is uploaded LAST.
type uploadServer struct {
	*httptest.Server
	mu       sync.Mutex
	received map[string][]byte
	order    []string
}

func newUploadServer() *uploadServer {
	u := &uploadServer{received: map[string][]byte{}}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		name := strings.TrimPrefix(r.URL.Path, "/")
		u.mu.Lock()
		u.received[name] = body
		u.order = append(u.order, name)
		u.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	return u
}

func allArtifactUploads(baseURL string) []protocol.ArchiveUpload {
	names := []string{"conversation", "cast", "bundle", "patch", "summary", "manifest"}
	uploads := make([]protocol.ArchiveUpload, 0, len(names))
	for _, n := range names {
		uploads = append(uploads, protocol.ArchiveUpload{Artifact: n, URL: baseURL + "/" + n})
	}
	return uploads
}

func gitRepoWithWIP(t *testing.T) string {
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
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "init")
	// Uncommitted tracked change → must show up in uncommitted.patch.
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Untracked file → must ALSO be captured (intent-to-add), so Restore can
	// reconstruct exact WIP, not just tracked changes.
	if err := os.WriteFile(filepath.Join(dir, "brand-new.txt"), []byte("fresh content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func sha256Of(b []byte) string {
	h := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(h[:])
}

func TestProduceUploadsAllArtifactsManifestLast(t *testing.T) {
	worktree := gitRepoWithWIP(t)

	castPath := filepath.Join(t.TempDir(), "session.cast")
	if err := os.WriteFile(castPath, []byte("cast-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	convPath := filepath.Join(t.TempDir(), "conversation.jsonl")
	if err := os.WriteFile(convPath, []byte(`{"t":"message"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := newUploadServer()
	defer srv.Close()

	sessionID := "sess-123"
	in := Input{
		WorkspaceID:      "ws-1",
		Worktree:         worktree,
		CastPath:         castPath,
		ConversationPath: convPath,
		SessionID:        &sessionID,
		ArchivedAt:       "2026-08-06T00:00:00Z",
		Summary: protocol.WorkspaceSummary{
			State:        "archived",
			StartedAt:    "2026-08-05T23:00:00Z",
			LastActivity: "2026-08-05T23:30:00Z",
			ChangedFiles: 1,
			TokenUsage: protocol.TokenUsageAmounts{
				InputTokens: 100, OutputTokens: 20,
			},
		},
		Uploads:       allArtifactUploads(srv.URL),
		ClaudeVersion: "claude-code-1.2.3",
	}

	manifest, err := Produce(context.Background(), in)
	if err != nil {
		t.Fatalf("Produce: %v", err)
	}

	// Every artifact was uploaded, and the manifest arrived LAST — its presence in
	// storage is the completion marker, so nothing may precede... err, follow it.
	if len(srv.order) != 6 {
		t.Fatalf("expected 6 uploads, got %d: %v", len(srv.order), srv.order)
	}
	if last := srv.order[len(srv.order)-1]; last != "manifest" {
		t.Fatalf("manifest must upload last, got order %v", srv.order)
	}

	// Cast and conversation are uploaded byte-for-byte from disk.
	if got := string(srv.received["cast"]); got != "cast-bytes" {
		t.Fatalf("cast bytes = %q", got)
	}

	// Checksums + sizes in the manifest match the actual uploaded bytes.
	for artifact, filename := range map[string]string{
		"conversation": ConversationName,
		"cast":         CastName,
		"bundle":       BundleName,
		"patch":        PatchName,
		"summary":      SummaryName,
	} {
		body := srv.received[artifact]
		if want := sha256Of(body); manifest.Checksums[filename] != want {
			t.Fatalf("checksum[%s] = %s, want %s", filename, manifest.Checksums[filename], want)
		}
		if manifest.Sizes[filename] != int64(len(body)) {
			t.Fatalf("size[%s] = %d, want %d", filename, manifest.Sizes[filename], len(body))
		}
	}

	// The returned manifest equals the uploaded manifest bytes.
	var uploaded Manifest
	if err := json.Unmarshal(srv.received["manifest"], &uploaded); err != nil {
		t.Fatalf("manifest json: %v", err)
	}
	if uploaded.WorkspaceID != "ws-1" || uploaded.Version != 1 {
		t.Fatalf("uploaded manifest mismatch: %+v", uploaded)
	}

	// Contract fields.
	if manifest.Tree.Kind != TreeKindGitBundlePatch {
		t.Fatalf("tree kind = %q", manifest.Tree.Kind)
	}
	if manifest.SessionID == nil || *manifest.SessionID != "sess-123" {
		t.Fatalf("sessionId = %v", manifest.SessionID)
	}
	if manifest.ClaudeVersion != "claude-code-1.2.3" || manifest.RuntimeVersion != "dev" {
		t.Fatalf("versions = %q / %q", manifest.RuntimeVersion, manifest.ClaudeVersion)
	}
	if manifest.LastCommit == nil {
		t.Fatal("lastCommit should be set for a repo with a commit")
	}
	if manifest.TokenUsage["input_tokens"] != 100 {
		t.Fatalf("tokenUsage = %v", manifest.TokenUsage)
	}

	// The bundle is a real git bundle; the patch captured the WIP edit.
	if !strings.HasPrefix(string(srv.received["bundle"]), "# v2 git bundle") {
		t.Fatalf("bundle is not a git bundle: %.20q", srv.received["bundle"])
	}
	patch := string(srv.received["patch"])
	if !strings.Contains(patch, "world") {
		t.Fatalf("patch missing tracked WIP change: %s", patch)
	}
	if !strings.Contains(patch, "fresh content") || !strings.Contains(patch, "brand-new.txt") {
		t.Fatalf("patch missing untracked file capture: %s", patch)
	}
}

func TestProduceStagesEmptyCastAndConversationWhenMissing(t *testing.T) {
	worktree := gitRepoWithWIP(t)
	srv := newUploadServer()
	defer srv.Close()

	in := Input{
		WorkspaceID:      "ws-2",
		Worktree:         worktree,
		CastPath:         filepath.Join(t.TempDir(), "does-not-exist.cast"),
		ConversationPath: "",
		Summary:          protocol.WorkspaceSummary{StartedAt: "2026-08-06T00:00:00Z"},
		ArchivedAt:       "2026-08-06T00:00:00Z",
		Uploads:          allArtifactUploads(srv.URL),
	}
	manifest, err := Produce(context.Background(), in)
	if err != nil {
		t.Fatalf("Produce: %v", err)
	}
	if len(srv.received["cast"]) != 0 || len(srv.received["conversation"]) != 0 {
		t.Fatal("missing cast/conversation should upload as empty artifacts")
	}
	if manifest.ClaudeVersion != "unknown" {
		t.Fatalf("claudeVersion fallback = %q", manifest.ClaudeVersion)
	}
	if manifest.SessionID != nil {
		t.Fatalf("sessionId should be nil, got %v", *manifest.SessionID)
	}
}

func TestProduceRejectsUnknownArtifact(t *testing.T) {
	worktree := gitRepoWithWIP(t)
	srv := newUploadServer()
	defer srv.Close()

	uploads := allArtifactUploads(srv.URL)
	uploads = append(uploads, protocol.ArchiveUpload{Artifact: "bogus", URL: srv.URL + "/bogus"})

	_, err := Produce(context.Background(), Input{
		WorkspaceID: "ws-3", Worktree: worktree,
		Summary:    protocol.WorkspaceSummary{StartedAt: "2026-08-06T00:00:00Z"},
		ArchivedAt: "2026-08-06T00:00:00Z", Uploads: uploads,
	})
	if err == nil || !strings.Contains(err.Error(), "unknown artifact") {
		t.Fatalf("expected unknown-artifact error, got %v", err)
	}
}

func TestProduceRequiresManifestUpload(t *testing.T) {
	worktree := gitRepoWithWIP(t)
	srv := newUploadServer()
	defer srv.Close()

	// Every artifact EXCEPT the manifest.
	var uploads []protocol.ArchiveUpload
	for _, u := range allArtifactUploads(srv.URL) {
		if u.Artifact != "manifest" {
			uploads = append(uploads, u)
		}
	}
	_, err := Produce(context.Background(), Input{
		WorkspaceID: "ws-4", Worktree: worktree,
		Summary:    protocol.WorkspaceSummary{StartedAt: "2026-08-06T00:00:00Z"},
		ArchivedAt: "2026-08-06T00:00:00Z", Uploads: uploads,
	})
	if err == nil || !strings.Contains(err.Error(), "missing the manifest") {
		t.Fatalf("expected missing-manifest error, got %v", err)
	}
}

func TestProduceRequiresEveryPayloadArtifact(t *testing.T) {
	worktree := gitRepoWithWIP(t)
	srv := newUploadServer()
	defer srv.Close()

	// Every artifact EXCEPT summary — Produce must refuse before uploading, so an
	// incomplete Snapshot is never marked complete by a manifest that points at a
	// missing object.
	var uploads []protocol.ArchiveUpload
	for _, u := range allArtifactUploads(srv.URL) {
		if u.Artifact != "summary" {
			uploads = append(uploads, u)
		}
	}
	_, err := Produce(context.Background(), Input{
		WorkspaceID: "ws-5", Worktree: worktree,
		Summary:    protocol.WorkspaceSummary{StartedAt: "2026-08-06T00:00:00Z"},
		ArchivedAt: "2026-08-06T00:00:00Z", Uploads: uploads,
	})
	if err == nil || !strings.Contains(err.Error(), "missing the summary") {
		t.Fatalf("expected missing-summary error, got %v", err)
	}
	if len(srv.order) != 0 {
		t.Fatalf("nothing should upload when an artifact is missing, got %v", srv.order)
	}
}
