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

	"runtime-agent/internal/claude"
	"runtime-agent/internal/tmux"
)

// Service holds the on-box layout and the tmux manager. One instance per agent.
type Service struct {
	// Root is the Runtime Computer working area, e.g. /home/runtime.
	Root string
	tmux *tmux.Manager
	env  []string
}

func NewService(root string) *Service {
	return &Service{Root: root, tmux: tmux.New(), env: os.Environ()}
}

func sessionName(workspaceID string) string { return "ws-" + workspaceID }

func (s *Service) mirrorPath() string      { return filepath.Join(s.Root, "repo.git") }
func (s *Service) worktreePath(id string) string {
	return filepath.Join(s.Root, "workspaces", id)
}

// Create adds a git worktree for the workspace from the shared bare mirror.
// The mirror itself (clone/fetch) is provisioned separately; this is the
// per-workspace step. Claude is not started until Start.
func (s *Service) Create(ctx context.Context, workspaceID, branch, baseRef string) (string, error) {
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
	if err := s.tmux.NewSession(ctx, name, worktree, claude.Command(), env); err != nil {
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
	if err := s.tmux.NewSession(ctx, name, worktree, claude.ContinueCommand(), env); err != nil {
		return "", err
	}
	return name, nil
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
