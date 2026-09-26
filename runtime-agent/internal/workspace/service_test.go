package workspace

import (
	"context"
	"strings"
	"testing"
)

func TestOrientationUsesRecordedFacts(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws1", "feature/login", "main")

	got := s.orientation("ws1", "/work/ws1")
	if !strings.Contains(got, "in the /work/ws1 directory") {
		t.Errorf("orientation did not use the worktree path:\n%s", got)
	}
	if !strings.Contains(got, "target branch for this workspace is origin/main") {
		t.Errorf("orientation did not use the recorded base branch:\n%s", got)
	}
}

func TestOrientationOmitsBaseWhenFactsMissing(t *testing.T) {
	s := NewService(t.TempDir())

	// No facts recorded (simulates a box restart before the next Create): the
	// base branch is unknown, so the target-branch guidance is omitted. The
	// worktree path is always supplied by the call site, so it still renders.
	got := s.orientation("ws-missing", "/work/ws-missing")
	if !strings.Contains(got, "in the /work/ws-missing directory") {
		t.Errorf("orientation did not include the worktree path:\n%s", got)
	}
	if strings.Contains(got, "target branch for this workspace") {
		t.Errorf("base guidance should be omitted when facts are missing:\n%s", got)
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
