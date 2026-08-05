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
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/protocol"
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

	summariesMu sync.Mutex
	summaries   map[string]*Summary
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
	return &Service{
		Root:      root,
		tmux:      tmux.New(),
		env:       os.Environ(),
		facts:     map[string]workspaceFacts{},
		summaries: map[string]*Summary{},
	}
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

// Start launches an interactive Claude session inside a fresh tmux session
// and launches the Workspace Summary collector for this workspace.
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
	s.beginSummary(workspaceID, worktree)
	return name, nil
}

// Resume re-launches Claude with --continue after an exit or box restart.
// The Summary collector is (re)started so post-restart activity is folded in.
func (s *Service) Resume(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	name := sessionName(workspaceID)
	_ = s.tmux.KillSession(ctx, name)
	worktree := s.worktreePath(workspaceID)
	env := claude.SessionEnv(s.env, anthropicToken)
	cmd := claude.ContinueCommand(s.orientation(ctx, workspaceID, worktree))
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	s.beginSummary(workspaceID, worktree)
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

// Stop ends the Claude session and stops the Summary collector, marking the
// summary's endedAt. The Summary itself is retained so a post-stop
// SummaryOf still returns the last-known state.
func (s *Service) Stop(ctx context.Context, workspaceID string) error {
	s.endSummary(workspaceID)
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

// SessionLog returns the current Claude JSONL path for a workspace, or "" if
// Claude hasn't written anything yet. Claude Code stores per-project logs at
// ~/.claude/projects/<slug>/<sessionId>.jsonl where <slug> is the working
// directory with '/' and '.' replaced by '-'. When --continue reopens a prior
// session it reuses that file, so "newest jsonl" == "current session."
func (s *Service) SessionLog(workspaceID string) string {
	slug := claudeSlug(s.worktreePath(workspaceID))
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(home, ".claude", "projects", slug)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var newest string
	var newestMod time.Time
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newestMod) {
			newestMod = info.ModTime()
			newest = filepath.Join(dir, e.Name())
		}
	}
	return newest
}

// claudeSlug encodes a filesystem path the way Claude Code does when building
// its per-project JSONL directory. Every '/' and '.' becomes '-'; nothing else
// changes. Empirically established in Spike 3/4.
func claudeSlug(path string) string {
	b := make([]byte, 0, len(path))
	for i := 0; i < len(path); i++ {
		c := path[i]
		if c == '/' || c == '.' {
			b = append(b, '-')
		} else {
			b = append(b, c)
		}
	}
	return string(b)
}

// beginSummary creates (or refreshes) the Workspace Summary collector for a
// workspace. Called from Start and Resume. Safe to call twice — the collector
// itself guards against re-launch.
func (s *Service) beginSummary(workspaceID, worktree string) {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	if !ok {
		sum = newSummary(workspaceID, worktree)
		s.summaries[workspaceID] = sum
	}
	s.summariesMu.Unlock()
	sum.start(func() string { return s.SessionLog(workspaceID) })
}

// endSummary stops the collector and marks the session as ended. The Summary
// stays in the map so post-stop SummaryOf still returns the last-known state.
func (s *Service) endSummary(workspaceID string) {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	s.summariesMu.Unlock()
	if !ok {
		return
	}
	sum.stop()
}

// SummaryOf returns the current WorkspaceSummary for a workspace. If Start
// hasn't been called yet, returns a "starting" placeholder with best-effort
// git stats — the shape stays stable for every consumer.
func (s *Service) SummaryOf(ctx context.Context, workspaceID string) protocol.WorkspaceSummary {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	s.summariesMu.Unlock()
	if !ok {
		return startingSummary(s.worktreePath(workspaceID))
	}
	return sum.Snapshot(ctx)
}
