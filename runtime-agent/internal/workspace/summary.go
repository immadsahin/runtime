package workspace

import (
	"context"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

// Summary maintains the running WorkspaceSummary for one workspace. It is the
// canonical shape Mission Engine and the M4 Snapshot manifest consume.
//
// Event-driven fields (state, timestamps, tokenUsage, lastAssistantMessage)
// are folded from the JSONL event stream inside a background collector.
// Git-derived fields (changedFiles, filesTouched, commitCount) are computed
// at Snapshot() time via `git` shell-outs — cheap enough for the Mission
// polling cadence and always fresh.
type Summary struct {
	workspaceID string
	worktree    string

	mu                   sync.Mutex
	startedAt            time.Time
	endedAt              *time.Time
	state                string
	lastActivityAt       time.Time
	tokenUsage           protocol.TokenUsageAmounts
	lastAssistantMessage string
	hasAssistantMessage  bool

	cancel context.CancelFunc // stops the collector goroutine when non-nil
}

// newSummary creates a Summary in the "running" state as of now. The collector
// is not started until start() is called (typically by Service.Start).
func newSummary(workspaceID, worktree string) *Summary {
	now := time.Now().UTC()
	return &Summary{
		workspaceID:    workspaceID,
		worktree:       worktree,
		startedAt:      now,
		state:          "running",
		lastActivityAt: now,
	}
}

// start launches the background collector: a conversation.Watcher tailing the
// workspace's JSONL, folding each event into the running summary. Safe to
// call twice — the first call wins.
func (s *Summary) start(sessionLog func() string) {
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.mu.Unlock()

	watcher := conversation.New(sessionLog, 0)
	out := make(chan conversation.Event, 64)
	go watcher.Run(ctx, out)
	go s.consume(ctx, out)
}

// stop marks the session as ended and cancels the collector.
func (s *Summary) stop() {
	s.mu.Lock()
	now := time.Now().UTC()
	s.endedAt = &now
	s.state = "exited"
	cancel := s.cancel
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Summary) consume(ctx context.Context, in <-chan conversation.Event) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-in:
			if !ok {
				return
			}
			s.applyEvent(ev)
		}
	}
}

func (s *Summary) applyEvent(ev conversation.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastActivityAt = time.Now().UTC()
	if ev.Message != nil {
		if ev.Message.Role == "assistant" {
			for _, block := range ev.Message.Content {
				if block.Type == "text" && block.Text != "" {
					s.lastAssistantMessage = block.Text
					s.hasAssistantMessage = true
				}
			}
		}
	}
	if ev.Usage != nil {
		s.tokenUsage.InputTokens += ev.Usage.InputTokens
		s.tokenUsage.OutputTokens += ev.Usage.OutputTokens
		s.tokenUsage.CacheCreationInputTokens += ev.Usage.CacheCreationInputTokens
		s.tokenUsage.CacheReadInputTokens += ev.Usage.CacheReadInputTokens
	}
}

// Snapshot returns the current WorkspaceSummary. Event-driven fields are read
// under the mutex; git-derived fields are shelled out at call time so the
// caller always sees the latest git state.
func (s *Summary) Snapshot(ctx context.Context) protocol.WorkspaceSummary {
	s.mu.Lock()
	startedAt := s.startedAt
	endedAt := s.endedAt
	state := s.state
	lastActivityAt := s.lastActivityAt
	tokenUsage := s.tokenUsage
	lastMsg := s.lastAssistantMessage
	hasMsg := s.hasAssistantMessage
	s.mu.Unlock()

	var endedAtStr *string
	if endedAt != nil {
		v := endedAt.Format(time.RFC3339)
		endedAtStr = &v
	}
	endMoment := time.Now().UTC()
	if endedAt != nil {
		endMoment = *endedAt
	}
	duration := int64(endMoment.Sub(startedAt).Seconds())
	if duration < 0 {
		duration = 0
	}

	var lastMsgPtr *string
	if hasMsg {
		v := lastMsg
		lastMsgPtr = &v
	}

	changed, touched, commits := gitStats(ctx, s.worktree)

	return protocol.WorkspaceSummary{
		State:                state,
		StartedAt:            startedAt.Format(time.RFC3339),
		EndedAt:              endedAtStr,
		Duration:             duration,
		LastActivity:         lastActivityAt.Format(time.RFC3339),
		TokenUsage:           tokenUsage,
		ChangedFiles:         changed,
		FilesTouched:         touched,
		CommitCount:          commits,
		LastAssistantMessage: lastMsgPtr,
	}
}

// startingSummary is what the agent returns when no collector has been created
// for a workspace yet (e.g., the workspace was created but never started). It
// preserves the "state" invariant without pretending Claude has activity.
func startingSummary(worktree string) protocol.WorkspaceSummary {
	now := time.Now().UTC().Format(time.RFC3339)
	return protocol.WorkspaceSummary{
		State:        "starting",
		StartedAt:    now,
		EndedAt:      nil,
		Duration:     0,
		LastActivity: now,
		TokenUsage:   protocol.TokenUsageAmounts{},
		ChangedFiles: 0,
		FilesTouched: []string{},
		CommitCount:  0,
	}
}

// gitStats reports (changedFiles, filesTouched, commitCount). All values fall
// back to zero/empty on error — the summary is best-effort, not a lock on the
// worktree. Runs the three commands sequentially; typical wall-clock is <20ms
// on a healthy worktree, well below the Mission poll cadence.
func gitStats(ctx context.Context, worktree string) (int, []string, int) {
	if worktree == "" {
		return 0, []string{}, 0
	}
	statusPaths := gitStatusPaths(ctx, worktree)
	logPaths := gitLogPaths(ctx, worktree)
	commits := gitCommitCount(ctx, worktree)

	// Union of status + log, deduped and sorted for a stable JSON response.
	set := make(map[string]struct{}, len(statusPaths)+len(logPaths))
	for _, p := range statusPaths {
		set[p] = struct{}{}
	}
	for _, p := range logPaths {
		set[p] = struct{}{}
	}
	touched := make([]string, 0, len(set))
	for p := range set {
		touched = append(touched, p)
	}
	sort.Strings(touched)
	return len(statusPaths), touched, commits
}

func gitStatusPaths(ctx context.Context, worktree string) []string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "status", "--porcelain=v1", "-uall").Output()
	if err != nil {
		return nil
	}
	var paths []string
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if len(line) < 4 {
			continue
		}
		// Format: "XY path" with 2-char status + space. Rename lines contain " -> ".
		path := line[3:]
		if arrow := strings.LastIndex(path, " -> "); arrow >= 0 {
			path = path[arrow+len(" -> "):]
		}
		if path != "" {
			paths = append(paths, path)
		}
	}
	return paths
}

func gitLogPaths(ctx context.Context, worktree string) []string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"log", "@{upstream}..HEAD", "--name-only", "--pretty=format:").Output()
	if err != nil {
		return nil
	}
	seen := make(map[string]struct{})
	var paths []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if _, dup := seen[line]; dup {
			continue
		}
		seen[line] = struct{}{}
		paths = append(paths, line)
	}
	return paths
}

func gitCommitCount(ctx context.Context, worktree string) int {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"rev-list", "--count", "@{upstream}..HEAD").Output()
	if err != nil {
		return 0
	}
	var n int
	for _, r := range strings.TrimSpace(string(out)) {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}
