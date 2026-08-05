// Package workspace orchestrates everything local to one Claude session on the
// Runtime Computer: its git worktree, its tmux session, and the Claude process.
// This is the agent's core service; the HTTP/WS server is a thin shell over it.
package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/tmux"
)

// Service holds the on-box layout and the tmux manager. One instance per agent.
type Service struct {
	// Root is the Runtime Computer working area, e.g. /home/runtime.
	Root string
	tmux *tmux.Manager
	env  []string

	mu    sync.Mutex
	facts map[string]workspaceFacts
}

// workspaceFacts are the per-workspace details Create learns and Start/Resume
// need to build Claude's orientation prompt. Held in memory only: on a box
// restart they are re-supplied by the control plane's next Create call, and
// Start degrades gracefully (branch read from the worktree, base omitted) when
// they're absent. Durable persistence is deferred until the Resume-after-restart
// path is actually wired.
type workspaceFacts struct {
	branch     string
	baseBranch string
}

func NewService(root string) *Service {
	return &Service{Root: root, tmux: tmux.New(), env: os.Environ(), facts: map[string]workspaceFacts{}}
}

func sessionName(workspaceID string) string { return "ws-" + workspaceID }

func (s *Service) mirrorPath() string { return filepath.Join(s.Root, "repo.git") }
func (s *Service) worktreePath(id string) string {
	return filepath.Join(s.Root, "workspaces", id)
}

// Create adds a git worktree for the workspace from the shared bare mirror.
// The mirror itself (clone/fetch) is provisioned separately; this is the
// per-workspace step. Claude is not started until Start.
func (s *Service) Create(ctx context.Context, workspaceID, branch, baseRef string) (string, error) {
	// Record the facts Start/Resume need for the orientation prompt, even on the
	// idempotent path below so a re-Create after a restart repopulates them.
	// baseRef arrives as a remote ref (e.g. "origin/main"); strip it for display.
	s.setFacts(workspaceID, branch, strings.TrimPrefix(baseRef, "origin/"))

	worktree := s.worktreePath(workspaceID)
	if _, err := os.Stat(worktree); err == nil {
		return worktree, nil // idempotent
	}
	if err := os.MkdirAll(filepath.Dir(worktree), 0o755); err != nil {
		return "", err
	}
	out, err := exec.CommandContext(ctx, "git", "-C", s.mirrorPath(),
		"worktree", "add", "-b", branch, worktree, baseRef).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("worktree add: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return worktree, nil
}

// Start launches an interactive Claude session inside a fresh tmux session.
func (s *Service) Start(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	name := sessionName(workspaceID)
	if s.tmux.HasSession(ctx, name) {
		return name, nil // already running
	}
	worktree := s.worktreePath(workspaceID)
	env := claude.SessionEnv(s.env, anthropicToken)
	cmd := claude.Command(s.orientation(ctx, workspaceID, worktree))
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	return name, nil
}

// Resume re-launches Claude with --continue after an exit or box restart.
func (s *Service) Resume(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	name := sessionName(workspaceID)
	_ = s.tmux.KillSession(ctx, name)
	worktree := s.worktreePath(workspaceID)
	env := claude.SessionEnv(s.env, anthropicToken)
	cmd := claude.ContinueCommand(s.orientation(ctx, workspaceID, worktree))
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	return name, nil
}

// orientation builds Claude's orientation prompt for a workspace. It prefers the
// facts recorded at Create; if those were lost (box restart before the next
// Create), it falls back to the branch checked out in the worktree and omits the
// base — a degraded but still-useful prompt (see claude.Orientation).
func (s *Service) orientation(ctx context.Context, workspaceID, worktree string) string {
	f, ok := s.getFacts(workspaceID)
	if !ok {
		f = workspaceFacts{branch: gitBranch(ctx, worktree)}
	}
	return claude.Orientation(f.branch, f.baseBranch)
}

func (s *Service) setFacts(workspaceID, branch, baseBranch string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.facts[workspaceID] = workspaceFacts{branch: branch, baseBranch: baseBranch}
}

func (s *Service) getFacts(workspaceID string) (workspaceFacts, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.facts[workspaceID]
	return f, ok
}

// gitBranch reports the branch checked out in worktree, or "" if it can't be
// determined. Best-effort: a missing branch only degrades the orientation prompt,
// so errors are swallowed rather than surfaced.
func gitBranch(ctx context.Context, worktree string) string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// Stop ends the Claude session (leaves the worktree in place).
func (s *Service) Stop(ctx context.Context, workspaceID string) error {
	return s.tmux.KillSession(ctx, sessionName(workspaceID))
}

// SessionName exposes the tmux session name the PTY handler attaches to.
func (s *Service) SessionName(workspaceID string) string { return sessionName(workspaceID) }

// Archive stops the session; uploading the PTY cast + JSONL to object storage
// and removing the worktree is wired in Milestone 4.
func (s *Service) Archive(ctx context.Context, workspaceID string) error {
	// TODO(M4): finalize + upload cast + JSONL, then mark read-only.
	return s.Stop(ctx, workspaceID)
}
