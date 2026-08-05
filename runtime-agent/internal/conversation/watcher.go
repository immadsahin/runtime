// Package conversation turns Claude Code's session JSONL into structured events
// for the conversation UI. It is a defensive, incremental byte-offset tail
// (validated in Spike 3/4): the format is Claude's internal, undocumented,
// version-tagged log, so the parser whitelists the record types it renders and
// tolerates everything else.
//
// Every emitted event carries an ID = the JSONL byte offset AT THE END of the
// record that produced it. That ID is the resume cursor: `Last-Event-ID: N`
// (SSE) means "I've consumed everything up to byte N; give me from there."
// This guarantees zero-dupe / zero-skip resume without any pub-sub state.
package conversation

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"time"

	"runtime-agent/internal/protocol"
)

// rawRecord is the subset of a Claude JSONL line the watcher understands.
type rawRecord struct {
	Type      string  `json:"type"`
	UUID      string  `json:"uuid"`
	ParentID  *string `json:"parentUuid"`
	Timestamp string  `json:"timestamp"`
	Message   *struct {
		Role    string                      `json:"role"`
		Content []protocol.ContentBlock     `json:"content"`
		Usage   *map[string]json.RawMessage `json:"usage"`
	} `json:"message"`
}

// Event is a decoded conversation event. Exactly one of Message/Usage is set.
// ID is the JSONL byte offset AT THE END of the record that produced this
// event — the resume cursor the SSE handler emits as `id:`.
type Event struct {
	ID      int64
	Message *protocol.ConversationMessage
	Usage   *protocol.TokenUsage
}

// PathFunc returns the JSONL path to tail. It may return "" while the file
// doesn't yet exist (Claude hasn't written anything); the watcher polls again
// on the next tick.
type PathFunc func() string

// Watcher incrementally tails one session file.
type Watcher struct {
	pathFn   PathFunc
	offset   int64
	partial  []byte
	interval time.Duration
	// Path last opened; a change resets offset/partial so switching JSONL
	// files (e.g. new Claude session) doesn't skip content.
	lastPath string
}

// New starts watching the path returned by pathFn, resuming from fromOffset
// (0 for a fresh subscription; a positive value from the client's last seen
// event ID for resume).
func New(pathFn PathFunc, fromOffset int64) *Watcher {
	return &Watcher{pathFn: pathFn, offset: fromOffset, interval: 250 * time.Millisecond}
}

// SetInterval overrides the poll interval (tests use short intervals).
func (w *Watcher) SetInterval(d time.Duration) { w.interval = d }

// Run polls the file until ctx is cancelled, emitting one Event per new
// user/assistant record on out. App-internal record types (queue-operation,
// attachment, ai-title, last-prompt, mode, pr-link, system, …) are ignored.
func (w *Watcher) Run(ctx context.Context, out chan<- Event) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	// Poll once immediately so subscribers see existing history without a tick delay.
	w.poll(ctx, out)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.poll(ctx, out)
		}
	}
}

func (w *Watcher) poll(ctx context.Context, out chan<- Event) {
	path := w.pathFn()
	if path == "" {
		return
	}
	if path != w.lastPath {
		// New JSONL file (Claude switched sessions); start from the caller's
		// original offset only for the first file, then reset for later ones.
		if w.lastPath != "" {
			w.offset = 0
			w.partial = nil
		}
		w.lastPath = path
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() <= w.offset {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	if _, err := f.Seek(w.offset, 0); err != nil {
		return
	}
	buf := make([]byte, info.Size()-w.offset)
	n, _ := f.Read(buf)

	// Split into full lines; buffer any partial trailing line for the next tick.
	// lineStart tracks each full line's start offset within the file so we can
	// emit an accurate end-of-line offset as the event ID.
	data := append(w.partial, buf[:n]...)
	// The start-of-data offset within the JSONL file:
	dataStart := w.offset - int64(len(w.partial))
	w.offset += int64(n)

	cursor := dataStart
	for {
		idx := bytes.IndexByte(data, '\n')
		if idx == -1 {
			w.partial = data
			return
		}
		line := data[:idx]
		lineEnd := cursor + int64(idx) + 1 // include the '\n'
		cursor = lineEnd
		data = data[idx+1:]

		if ev, ok := decode(line); ok {
			ev.ID = lineEnd
			select {
			case <-ctx.Done():
				return
			case out <- ev:
			}
		}
	}
}

func decode(line []byte) (Event, bool) {
	if len(bytes.TrimSpace(line)) == 0 {
		return Event{}, false
	}
	var rec rawRecord
	if err := json.Unmarshal(line, &rec); err != nil {
		return Event{}, false // tolerate unparseable lines
	}
	if rec.Type != "user" && rec.Type != "assistant" {
		return Event{}, false // ignore app-internal record types
	}
	if rec.Message == nil {
		return Event{}, false
	}
	msg := &protocol.ConversationMessage{
		T:          "message",
		UUID:       rec.UUID,
		ParentUUID: rec.ParentID,
		Role:       rec.Message.Role,
		Timestamp:  rec.Timestamp,
		Content:    rec.Message.Content,
	}
	return Event{Message: msg}, true
}

// UsageFrom parses a raw Claude usage payload into a TokenUsage event. Exposed
// for tests and future callers that fold usage into the stream once we choose
// where to emit it (currently the watcher doesn't — usage is per-turn, not
// per-line, and is derivable from the assistant message; wire in Phase 3).
func UsageFrom(raw map[string]json.RawMessage) *protocol.TokenUsage {
	if raw == nil {
		return nil
	}
	u := &protocol.TokenUsage{T: "usage"}
	_ = json.Unmarshal(raw["input_tokens"], &u.InputTokens)
	_ = json.Unmarshal(raw["output_tokens"], &u.OutputTokens)
	_ = json.Unmarshal(raw["cache_creation_input_tokens"], &u.CacheCreationInputTokens)
	_ = json.Unmarshal(raw["cache_read_input_tokens"], &u.CacheReadInputTokens)
	_ = json.Unmarshal(raw["service_tier"], &u.ServiceTier)
	return u
}
