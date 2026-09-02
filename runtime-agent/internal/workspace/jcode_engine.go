package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"runtime-agent/internal/jcode"
)

// jcodeFlushInterval bounds how long streamed assistant text waits before the
// in-progress turn is written to the conversation log (and thus reaches the
// browser). Small enough to feel live, large enough to coalesce token deltas.
const jcodeFlushInterval = 200 * time.Millisecond

// jcodeEngine runs workspaces as sessions on a single `jcode api-bridge` rather
// than one Claude process per tmux session. One bridge (one Client) multiplexes
// every workspace; a single goroutine drains the shared event stream and fans
// frames out to per-workspace consumers, each writing Claude-shaped records to
// its workspace's conversation log. Because that log is exactly what SessionLog
// returns, the SSE /events, Summary, and Archive pipelines are reused unchanged.
//
// Consumer access is confined to the run() goroutine and the mutex: route,
// flush, and the file close on StopSession all hold e.mu, so a session's
// consumer and file are never touched concurrently.
type jcodeEngine struct {
	client *jcode.Client
	root   string

	mu      sync.Mutex
	byWS    map[string]*jcodeSession // workspaceID -> session
	byJcode map[string]*jcodeSession // jcode session id -> session (demux routing)

	stop chan struct{}
	once sync.Once
}

type jcodeSession struct {
	workspaceID string
	jcodeID     string
	consumer    *jcode.SessionConsumer
	file        *os.File
}

// newJcodeEngine wraps a connected client and starts the demux/flush loop.
func newJcodeEngine(client *jcode.Client, root string) *jcodeEngine {
	e := &jcodeEngine{
		client:  client,
		root:    root,
		byWS:    map[string]*jcodeSession{},
		byJcode: map[string]*jcodeSession{},
		stop:    make(chan struct{}),
	}
	go e.run()
	return e
}

// conversationPath is where a workspace's assembled conversation log lives —
// outside any worktree, keyed by workspace id.
func (e *jcodeEngine) conversationPath(workspaceID string) string {
	return filepath.Join(e.root, "conversations", workspaceID+".jsonl")
}

// StartSession opens a jcode session rooted at worktree and begins writing its
// conversation log. Idempotent: a workspace already running is left as-is.
func (e *jcodeEngine) StartSession(ctx context.Context, workspaceID, worktree string) error {
	e.mu.Lock()
	_, running := e.byWS[workspaceID]
	e.mu.Unlock()
	if running {
		return nil
	}

	sess, err := e.client.CreateSession(ctx, worktree)
	if err != nil {
		return fmt.Errorf("jcode start %s: %w", workspaceID, err)
	}

	path := e.conversationPath(workspaceID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Truncate: Start begins a fresh session, so the log starts empty. SSE
	// resume is within a session (never across a Start), so this is safe.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}

	js := &jcodeSession{
		workspaceID: workspaceID,
		jcodeID:     sess.SessionID,
		consumer:    jcode.NewSessionConsumer(sess.SessionID, f, time.Now),
		file:        f,
	}
	e.mu.Lock()
	e.byWS[workspaceID] = js
	e.byJcode[sess.SessionID] = js
	e.mu.Unlock()
	return nil
}

// SendMessage delivers a user prompt to a workspace's session, starting a turn.
func (e *jcodeEngine) SendMessage(workspaceID, content string) error {
	e.mu.Lock()
	js, ok := e.byWS[workspaceID]
	e.mu.Unlock()
	if !ok {
		return fmt.Errorf("jcode: no session for workspace %s", workspaceID)
	}
	return e.client.SendMessage(js.jcodeID, content)
}

// StopSession stops consuming a workspace's events and closes its log. The jcode
// session persists on the bridge; only Runtime's view of it is torn down.
func (e *jcodeEngine) StopSession(workspaceID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	js, ok := e.byWS[workspaceID]
	if !ok {
		return
	}
	delete(e.byWS, workspaceID)
	delete(e.byJcode, js.jcodeID)
	if js.file != nil {
		_ = js.file.Close()
	}
}

// Active reports whether a workspace currently has a live jcode session.
func (e *jcodeEngine) Active(workspaceID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.byWS[workspaceID]
	return ok
}

// ConversationLog returns the workspace's conversation log path once it exists,
// or "" — the shape SessionLog needs.
func (e *jcodeEngine) ConversationLog(workspaceID string) string {
	path := e.conversationPath(workspaceID)
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	return path
}

// run is the single goroutine that owns every consumer: it routes each event to
// its session and flushes in-progress turns on a timer.
func (e *jcodeEngine) run() {
	ticker := time.NewTicker(jcodeFlushInterval)
	defer ticker.Stop()
	for {
		select {
		case f, ok := <-e.client.Events():
			if !ok {
				return // bridge connection closed
			}
			e.route(f)
		case <-ticker.C:
			e.flushAll()
		case <-e.stop:
			return
		}
	}
}

func (e *jcodeEngine) route(f jcode.Frame) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if js := e.byJcode[f.SessionID]; js != nil {
		_ = js.consumer.Handle(f)
	}
}

func (e *jcodeEngine) flushAll() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, js := range e.byWS {
		_ = js.consumer.Flush()
	}
}

// Close stops the run loop. Sessions' files are closed by StopSession; a process
// exit reclaims any left open.
func (e *jcodeEngine) Close() {
	e.once.Do(func() { close(e.stop) })
}
