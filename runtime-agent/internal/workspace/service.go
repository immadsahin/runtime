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

	"runtime-agent/internal/cast"
	"runtime-agent/internal/claude"
	"runtime-agent/internal/jcode"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/snapshot"
	"runtime-agent/internal/tmux"
)

// Service holds the on-box layout and the tmux manager. One instance per agent.
type Service struct {
	// Root is the Runtime Computer working area, e.g. /home/runtime.
	Root string
	tmux *tmux.Manager
	env  []string
	// secrets are values that can legitimately appear in the Claude process
	// environment. The HTTP server uses them to redact browser-visible PTY
	// output. Agent control variables never enter env in the first place.
	secrets []string

	mu    sync.Mutex
	facts map[string]workspaceFacts

	summariesMu sync.Mutex
	summaries   map[string]*Summary

	// recorders capture each session's terminal to an asciinema cast, started at
	// session start (M4 invariant #3: recording is independent of any browser).
	recordersMu sync.Mutex
	recorders   map[string]*cast.Recorder

	// jcode, when set, runs workspaces as sessions on a jcode api-bridge instead
	// of Claude-in-tmux. nil means the default Claude Code engine. Start, Stop,
	// SessionLog, SessionAlive, and SendMessage branch on it.
	jcode *jcodeEngine
}

// UseJcode switches the service to the jcode engine, driving workspaces through
// the given (already connected) harness-API client instead of Claude-in-tmux.
// Called once at construction when RUNTIME_ENGINE=jcode.
func (s *Service) UseJcode(client *jcode.Client) {
	s.jcode = newJcodeEngine(client, s.Root)
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
	env, secrets := sessionEnvironment(os.Environ())
	return &Service{
		Root:      root,
		tmux:      tmux.New(),
		env:       env,
		secrets:   secrets,
		facts:     map[string]workspaceFacts{},
		summaries: map[string]*Summary{},
		recorders: map[string]*cast.Recorder{},
	}
}

// sessionEnvironment keeps only the credentials Claude Code itself supports
// and excludes the Runtime agent's control-plane secret and launch variables.
// This prevents an interactive shell from reading RUNTIME_AGENT_SECRET via
// `env`, while keeping non-sensitive OS settings such as PATH and HOME.
func sessionEnvironment(base []string) ([]string, []string) {
	env := make([]string, 0, len(base))
	secrets := make([]string, 0, 2)
	for _, entry := range base {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "RUNTIME_AGENT_SECRET", "RUNTIME_AGENT_ROOT", "PORT":
			continue
		case "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY":
			if value != "" {
				secrets = append(secrets, value)
			}
		}
		env = append(env, entry)
	}
	return env, secrets
}

// RedactionSecrets returns a defensive copy of values that must not be sent to
// a browser in terminal output.
func (s *Service) RedactionSecrets() []string {
	return append([]string(nil), s.secrets...)
}

func sessionName(workspaceID string) string { return "ws-" + workspaceID }

func (s *Service) mirrorPath() string { return filepath.Join(s.Root, "repo.git") }
func (s *Service) worktreePath(id string) string {
	return filepath.Join(s.Root, "workspaces", id)
}

// castDir holds a workspace's terminal cast, kept OUTSIDE the worktree so the
// recording never pollutes the git tree (bundle/patch/changedFiles) it archives.
func (s *Service) castDir(id string) string {
	return filepath.Join(s.Root, "casts", id)
}
func (s *Service) castPath(id string) string {
	return filepath.Join(s.castDir(id), cast.DefaultCastName)
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
	if s.jcode != nil {
		if err := s.jcode.StartSession(ctx, workspaceID, s.worktreePath(workspaceID)); err != nil {
			return "", err
		}
		s.beginSummary(workspaceID, s.worktreePath(workspaceID))
		return name, nil
	}
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
	s.startRecorder(ctx, workspaceID)
	return name, nil
}

// Resume re-launches Claude with --continue after an exit or box restart.
// The Summary collector is (re)started so post-restart activity is folded in.
func (s *Service) Resume(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	name := sessionName(workspaceID)
	if s.jcode != nil {
		// jcode sessions live on the bridge; StartSession is idempotent and
		// re-attaches Runtime's view. --continue semantics are the bridge's.
		if err := s.jcode.StartSession(ctx, workspaceID, s.worktreePath(workspaceID)); err != nil {
			return "", err
		}
		s.beginSummary(workspaceID, s.worktreePath(workspaceID))
		return name, nil
	}
	_ = s.tmux.KillSession(ctx, name)
	worktree := s.worktreePath(workspaceID)
	env := claude.SessionEnv(s.env, anthropicToken)
	cmd := claude.ContinueCommand(s.orientation(ctx, workspaceID, worktree))
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	s.beginSummary(workspaceID, worktree)
	s.startRecorder(ctx, workspaceID)
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
	if s.jcode != nil {
		s.jcode.StopSession(workspaceID)
		s.endSummary(workspaceID)
		return nil
	}
	// Finalize the cast BEFORE killing tmux — the recorder taps the live pane, so
	// the pane must still exist while it drains its tail and closes the file.
	s.stopRecorder(ctx, workspaceID)
	s.endSummary(workspaceID)
	return s.tmux.KillSession(ctx, sessionName(workspaceID))
}

// SendMessage delivers a user prompt to a workspace's agent session. This is the
// jcode-mode prompt path (the Claude/tmux engine receives prompts by typing into
// the PTY instead), so it returns an error when the jcode engine is not active.
func (s *Service) SendMessage(workspaceID, content string) error {
	if s.jcode == nil {
		return fmt.Errorf("send message requires the jcode engine")
	}
	return s.jcode.SendMessage(workspaceID, content)
}

// SessionName exposes the tmux session name the PTY handler attaches to.
func (s *Service) SessionName(workspaceID string) string { return sessionName(workspaceID) }

// Archive produces a Workspace Snapshot: it stops the session (finalizing the
// cast and the Summary), captures the conversation, git tree, and Summary as
// immutable artifacts, and uploads them — manifest LAST — through the signed
// URLs the control plane minted. It returns the manifest so Next can cache it.
//
// The worktree is intentionally LEFT IN PLACE: reclaiming it is coupled with
// Restore (a later slice), so archived work stays recoverable until Restore can
// revive it. Archive is idempotent — re-archiving a stopped session simply
// re-captures and re-uploads.
func (s *Service) Archive(ctx context.Context, workspaceID string, req protocol.ArchiveWorkspaceRequest) (*snapshot.Manifest, error) {
	if err := s.Stop(ctx, workspaceID); err != nil {
		return nil, err
	}

	summary := s.SummaryOf(ctx, workspaceID)
	summary.State = "archived" // the Snapshot captures the archived session

	return snapshot.Produce(ctx, snapshot.Input{
		WorkspaceID:      workspaceID,
		Worktree:         s.worktreePath(workspaceID),
		CastPath:         s.castPath(workspaceID),
		ConversationPath: s.SessionLog(workspaceID),
		SessionID:        s.sessionID(workspaceID),
		Summary:          summary,
		ArchivedAt:       req.ArchivedAt,
		Uploads:          req.Uploads,
		ClaudeVersion:    snapshot.ClaudeVersion(ctx),
	})
}

// Restore rebuilds an archived Session from its Snapshot and relaunches Claude
// with `claude --continue`. The agent materializes + VERIFIES the worktree
// before booting Claude (M4 invariant #4); a verification failure returns an
// error and Claude is never started. The box need not be the original one —
// everything is rebuilt from the Snapshot's tree + conversation (portability).
func (s *Service) Restore(ctx context.Context, workspaceID string, req protocol.RestoreWorkspaceRequest) (string, error) {
	if req.SessionID == nil || *req.SessionID == "" {
		return "", fmt.Errorf("cannot restore: snapshot has no Claude session id")
	}
	// The session id becomes a filename under ~/.claude/projects/<slug>/; reject
	// anything that could escape that directory (path separators, traversal).
	if !validSessionID(*req.SessionID) {
		return "", fmt.Errorf("cannot restore: invalid session id %q", *req.SessionID)
	}
	worktree := s.worktreePath(workspaceID)
	convDest, err := s.conversationDest(worktree, *req.SessionID)
	if err != nil {
		return "", err
	}
	if err := snapshot.Materialize(ctx, snapshot.MaterializeInput{
		MirrorPath:       s.mirrorPath(),
		WorktreePath:     worktree,
		Branch:           req.Branch,
		ConversationDest: convDest,
		Downloads:        req.Downloads,
	}); err != nil {
		return "", err
	}
	// Verified — safe to boot Claude. Record the facts the orientation prompt
	// needs, then relaunch with --continue against the restored session.
	s.setFacts(workspaceID, req.Branch, req.BaseBranch)
	return s.Resume(ctx, workspaceID, "")
}

// validSessionID guards the session id before it is used as a path segment. A
// Claude session id is a plain filename (uuid-like); anything with a path
// separator or traversal is rejected so a malicious manifest can't write outside
// the project directory.
func validSessionID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return !strings.ContainsAny(id, "/\\") && !strings.Contains(id, "..")
}

// conversationDest is where the restored conversation JSONL must be written so
// `claude --continue` finds the archived session: Claude's per-project log path
// for this worktree, named by the session id.
func (s *Service) conversationDest(worktree, sessionID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects", claudeSlug(worktree), sessionID+".jsonl"), nil
}

// sessionID returns the Claude session id for `claude --continue` on Restore —
// the JSONL basename without extension — or nil when Claude never wrote a log.
func (s *Service) sessionID(workspaceID string) *string {
	log := s.SessionLog(workspaceID)
	if log == "" {
		return nil
	}
	id := strings.TrimSuffix(filepath.Base(log), filepath.Ext(log))
	if id == "" {
		return nil
	}
	return &id
}

// startRecorder begins capturing the workspace's tmux pane to its cast file.
// Best-effort: recording must never block a session start, so a failure is
// swallowed (the archive later stages an empty cast if none was produced). Any
// recorder already running for this workspace is finalized first (e.g. a Resume
// after Claude exited without a Stop) so its goroutine + FIFO don't leak.
func (s *Service) startRecorder(ctx context.Context, workspaceID string) {
	s.stopRecorder(ctx, workspaceID)
	rec := cast.NewSessionRecorder(sessionName(workspaceID), s.castDir(workspaceID), cast.Options{})
	s.recordersMu.Lock()
	s.recorders[workspaceID] = rec
	s.recordersMu.Unlock()
	_ = rec.Start(ctx)
}

// stopRecorder finalizes and drops the workspace's recorder. Idempotent.
func (s *Service) stopRecorder(ctx context.Context, workspaceID string) {
	s.recordersMu.Lock()
	rec := s.recorders[workspaceID]
	delete(s.recorders, workspaceID)
	s.recordersMu.Unlock()
	if rec != nil {
		_ = rec.Stop(ctx)
	}
}

// SessionAlive reports whether the workspace's tmux session (and therefore its
// Claude process) is still running. The PTY handler uses this to tell a client
// *detach* (the tmux attach client EOFs, but Claude keeps running) apart from a
// real process *exit* — only the latter should surface as an exit to the UI.
func (s *Service) SessionAlive(ctx context.Context, workspaceID string) bool {
	if s.jcode != nil {
		return s.jcode.Active(workspaceID)
	}
	return s.tmux.HasSession(ctx, sessionName(workspaceID))
}

// Destroy stops the Claude session and removes its worktree from the shared
// bare mirror. Unlike Archive, this is terminal: the persisted Workspace row
// is marked destroyed by the control plane and a future workspace receives a
// new branch/worktree. The operation is idempotent for a worktree already
// removed by an earlier request.
func (s *Service) Destroy(ctx context.Context, workspaceID string) error {
	_ = s.Stop(ctx, workspaceID)
	worktree := s.worktreePath(workspaceID)
	if _, err := os.Stat(worktree); os.IsNotExist(err) {
		s.forgetWorkspace(workspaceID)
		return nil
	}
	out, err := exec.CommandContext(
		ctx,
		"git",
		"-C",
		s.mirrorPath(),
		"worktree",
		"remove",
		"--force",
		worktree,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("worktree remove: %v: %s", err, strings.TrimSpace(string(out)))
	}
	s.forgetWorkspace(workspaceID)
	return nil
}

func (s *Service) forgetWorkspace(workspaceID string) {
	s.mu.Lock()
	delete(s.facts, workspaceID)
	s.mu.Unlock()
	s.summariesMu.Lock()
	delete(s.summaries, workspaceID)
	s.summariesMu.Unlock()
	s.recordersMu.Lock()
	delete(s.recorders, workspaceID)
	s.recordersMu.Unlock()
}

// SessionLog returns the current Claude JSONL path for a workspace, or "" if
// Claude hasn't written anything yet. Claude Code stores per-project logs at
// ~/.claude/projects/<slug>/<sessionId>.jsonl where <slug> is the working
// directory with '/' and '.' replaced by '-'. When --continue reopens a prior
// session it reuses that file, so "newest jsonl" == "current session."
func (s *Service) SessionLog(workspaceID string) string {
	if s.jcode != nil {
		return s.jcode.ConversationLog(workspaceID)
	}
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
