package workspace

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func TestOrientationUsesRecordedFacts(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws1", "feature/login", "main")

	// worktree path is irrelevant here: recorded facts short-circuit the git fallback.
	got := s.orientation(context.Background(), "ws1", "/nonexistent")
	if !strings.Contains(got, "on branch `feature/login`, based on `main`,") {
		t.Errorf("orientation did not use recorded facts:\n%s", got)
	}
}

func TestOrientationFallsBackToWorktreeBranch(t *testing.T) {
	s := NewService(t.TempDir())
	worktree := initRepoOnBranch(t, "recovered-branch")

	// No facts recorded (simulates a box restart): branch comes from git, base is omitted.
	got := s.orientation(context.Background(), "ws-missing", worktree)
	if !strings.Contains(got, "on branch `recovered-branch`,") {
		t.Errorf("orientation did not derive branch from worktree:\n%s", got)
	}
	if strings.Contains(got, "based on") {
		t.Errorf("base should be omitted when only git-derived:\n%s", got)
	}
}

func TestCreateStripsRemotePrefixFromBase(t *testing.T) {
	s := NewService(t.TempDir())
	// Create's git worktree step fails (no mirror), but facts are recorded first.
	_, _ = s.Create(context.Background(), "ws2", "feature/x", "origin/develop")

	f, ok := s.getFacts("ws2")
	if !ok {
		t.Fatal("Create did not record facts")
	}
	if f.branch != "feature/x" || f.baseBranch != "develop" {
		t.Errorf("facts = %+v, want {feature/x develop}", f)
	}
}

func TestGitBranchReturnsEmptyOutsideRepo(t *testing.T) {
	if got := gitBranch(context.Background(), t.TempDir()); got != "" {
		t.Errorf("gitBranch outside a repo = %q, want empty", got)
	}
}

func TestSessionEnvironmentExcludesAgentControlSecrets(t *testing.T) {
	env, secrets := sessionEnvironment([]string{
		"PATH=/usr/bin",
		"RUNTIME_AGENT_SECRET=control-secret",
		"RUNTIME_AGENT_ROOT=/home/runtime",
		"PORT=8080",
		"CLAUDE_CODE_OAUTH_TOKEN=claude-secret",
	})
	got := strings.Join(env, "\n")
	if strings.Contains(got, "RUNTIME_AGENT_SECRET") || strings.Contains(got, "RUNTIME_AGENT_ROOT") || strings.Contains(got, "PORT=8080") {
		t.Fatalf("agent control variables leaked to session environment: %q", got)
	}
	if !strings.Contains(got, "CLAUDE_CODE_OAUTH_TOKEN=claude-secret") || len(secrets) != 1 || secrets[0] != "claude-secret" {
		t.Fatalf("Claude credential was not retained safely: env=%q secrets=%q", got, secrets)
	}
}

// initRepoOnBranch creates a throwaway git repo checked out on the named branch
// and returns its path.
func initRepoOnBranch(t *testing.T, branch string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", branch)
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	run("commit", "-q", "--allow-empty", "-m", "init")
	return dir
}

func TestValidSessionIDRejectsPathEscapes(t *testing.T) {
	good := []string{"sess-123", "a1b2c3d4", "0e3f-9c2a"}
	for _, id := range good {
		if !validSessionID(id) {
			t.Errorf("valid session id %q rejected", id)
		}
	}
	bad := []string{"", ".", "..", "../x", "a/b", "a\\b", "x/../y", "..\\y"}
	for _, id := range bad {
		if validSessionID(id) {
			t.Errorf("path-escaping session id %q accepted", id)
		}
	}
}
