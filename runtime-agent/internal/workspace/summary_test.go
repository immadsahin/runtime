package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

// gitWorktree returns a fresh worktree with one commit + one modified file +
// one untracked file, so the git-derived summary fields have signal to read.
func gitWorktree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	sh := func(args ...string) {
		out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	sh("init", "-b", "work")
	sh("config", "user.email", "t@t")
	sh("config", "user.name", "t")
	// Initial commit on the base branch.
	write("README.md", "hi\n")
	sh("add", "README.md")
	sh("commit", "-m", "init")
	// Branch off and set an upstream so @{upstream} resolves.
	sh("branch", "base")
	sh("branch", "--set-upstream-to=base", "work")
	// One commit on top of base — counts toward commitCount + filesTouched.
	write("a.txt", "a\n")
	sh("add", "a.txt")
	sh("commit", "-m", "add a")
	// One modified file + one untracked — both show in status.
	write("README.md", "hi again\n")
	write("b.txt", "b\n")
	return dir
}

func TestStartingSummary(t *testing.T) {
	sum := startingSummary(t.TempDir())
	if sum.State != "starting" {
		t.Fatalf("state = %q, want starting", sum.State)
	}
	if sum.EndedAt != nil {
		t.Fatalf("endedAt should be nil, got %v", sum.EndedAt)
	}
	if sum.Duration != 0 {
		t.Fatalf("duration should be 0, got %d", sum.Duration)
	}
	if sum.LastAssistantMessage != nil {
		t.Fatal("lastAssistantMessage should be nil")
	}
	if len(sum.FilesTouched) != 0 {
		t.Fatalf("filesTouched should be empty, got %v", sum.FilesTouched)
	}
}

func TestSummarySnapshotFoldsMessageAndUsage(t *testing.T) {
	sum := newSummary("ws-1", t.TempDir())

	sum.applyEvent(conversation.Event{
		Message: &protocol.ConversationMessage{
			Role: "assistant",
			Content: []protocol.ContentBlock{
				{Type: "text", Text: "First reply."},
			},
		},
	})
	sum.applyEvent(conversation.Event{
		Usage: &protocol.TokenUsage{
			InputTokens: 10, OutputTokens: 20,
			CacheCreationInputTokens: 30, CacheReadInputTokens: 40,
		},
	})
	sum.applyEvent(conversation.Event{
		Message: &protocol.ConversationMessage{
			Role: "assistant",
			Content: []protocol.ContentBlock{
				{Type: "text", Text: "Second reply."},
			},
		},
	})
	sum.applyEvent(conversation.Event{
		Usage: &protocol.TokenUsage{
			InputTokens: 1, OutputTokens: 2,
			CacheCreationInputTokens: 3, CacheReadInputTokens: 4,
		},
	})

	snap := sum.Snapshot(context.Background())
	if snap.LastAssistantMessage == nil || *snap.LastAssistantMessage != "Second reply." {
		t.Fatalf("lastAssistantMessage should be latest text, got %v", snap.LastAssistantMessage)
	}
	if snap.TokenUsage.InputTokens != 11 || snap.TokenUsage.OutputTokens != 22 ||
		snap.TokenUsage.CacheCreationInputTokens != 33 || snap.TokenUsage.CacheReadInputTokens != 44 {
		t.Fatalf("tokenUsage should accumulate, got %+v", snap.TokenUsage)
	}
	if snap.State != "running" {
		t.Fatalf("state should be running, got %q", snap.State)
	}
	if snap.EndedAt != nil {
		t.Fatalf("endedAt should be nil while running")
	}
}

func TestSummaryStopSetsEndedAtAndState(t *testing.T) {
	sum := newSummary("ws-1", t.TempDir())
	sum.stop()
	snap := sum.Snapshot(context.Background())
	if snap.State != "exited" {
		t.Fatalf("state should be exited, got %q", snap.State)
	}
	if snap.EndedAt == nil {
		t.Fatal("endedAt should be set after stop")
	}
	if snap.Duration < 0 {
		t.Fatalf("duration must be non-negative, got %d", snap.Duration)
	}
	// Snapshot again after a wall-clock delay: duration is frozen at endedAt,
	// so a post-stop snapshot must not keep counting up.
	first := snap.Duration
	time.Sleep(1100 * time.Millisecond)
	second := sum.Snapshot(context.Background()).Duration
	if second != first {
		t.Fatalf("duration should be frozen at endedAt; first=%d second=%d", first, second)
	}
}

func TestSummaryGitStatsAgainstRealWorktree(t *testing.T) {
	wt := gitWorktree(t)
	sum := newSummary("ws-1", wt)

	snap := sum.Snapshot(context.Background())

	// git status shows a.txt was committed but README modified + b.txt untracked.
	// changedFiles counts status-only paths (README modified + b.txt untracked = 2).
	if snap.ChangedFiles != 2 {
		t.Fatalf("changedFiles = %d, want 2 (README modified + b.txt untracked); status paths: %v",
			snap.ChangedFiles, snap.FilesTouched)
	}
	// filesTouched is the sorted UNION of status + log-since-upstream paths.
	// Expect: README.md (status) + a.txt (log) + b.txt (status).
	want := []string{"README.md", "a.txt", "b.txt"}
	if len(snap.FilesTouched) != len(want) {
		t.Fatalf("filesTouched len = %d, want %d (%v vs %v)",
			len(snap.FilesTouched), len(want), snap.FilesTouched, want)
	}
	for i, p := range want {
		if snap.FilesTouched[i] != p {
			t.Fatalf("filesTouched[%d] = %q, want %q (%v)", i, snap.FilesTouched[i], p, snap.FilesTouched)
		}
	}
	if snap.CommitCount != 1 {
		t.Fatalf("commitCount = %d, want 1 (one commit ahead of base)", snap.CommitCount)
	}
}

func TestServiceSummaryOfUnknownWorkspace(t *testing.T) {
	svc := NewService(t.TempDir())
	snap := svc.SummaryOf(context.Background(), "never-started")
	if snap.State != "starting" {
		t.Fatalf("unknown workspace should return starting summary, got %q", snap.State)
	}
}
