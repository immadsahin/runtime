// Package conversation turns Claude Code's session JSONL into structured events
// for the conversation UI. It is a defensive, incremental byte-offset tail
// (validated in Spike 3/4): the format is Claude's internal, undocumented,
// version-tagged log, so the parser whitelists the record types it renders and
// tolerates everything else.
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
		Role    string                    `json:"role"`
		Content []protocol.ContentBlock   `json:"content"`
		Usage   *map[string]json.RawMessage `json:"usage"`
	} `json:"message"`
}

// Event is a decoded conversation event; exactly one field is non-nil.
type Event struct {
	Message *protocol.ConversationMessage
	Usage   *protocol.TokenUsage
}

// Watcher incrementally tails one session file.
type Watcher struct {
	path     string
	offset   int64
	partial  []byte
	interval time.Duration
}

// New starts watching path from the given byte offset (0 for the whole file).
func New(path string, fromOffset int64) *Watcher {
	return &Watcher{path: path, offset: fromOffset, interval: 500 * time.Millisecond}
}

// Run polls the file until ctx is cancelled, emitting one Event per new
// user/assistant record on out. App-internal record types (queue-operation,
// attachment, ai-title, last-prompt, mode, pr-link, system, …) are ignored.
func (w *Watcher) Run(ctx context.Context, out chan<- Event) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.poll(out)
		}
	}
}

func (w *Watcher) poll(out chan<- Event) {
	info, err := os.Stat(w.path)
	if err != nil || info.Size() <= w.offset {
		return
	}
	f, err := os.Open(w.path)
	if err != nil {
		return
	}
	defer f.Close()
	if _, err := f.Seek(w.offset, 0); err != nil {
		return
	}
	buf := make([]byte, info.Size()-w.offset)
	n, _ := f.Read(buf)
	w.offset += int64(n)

	// Buffer a partial trailing line until its newline arrives.
	data := append(w.partial, buf[:n]...)
	lines := bytes.Split(data, []byte("\n"))
	w.partial = lines[len(lines)-1]
	for _, line := range lines[:len(lines)-1] {
		if ev, ok := decode(line); ok {
			out <- ev
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
