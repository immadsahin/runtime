package conversation

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Two consecutive assistant lines. Byte offsets (end-of-line, includes '\n'):
//   line 1 → offset 158
//   line 2 → offset 315
const twoLines = `{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
`

func writeJSONL(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

// drain collects events on out until ctx expires or `stop` fires, then returns.
func drain(t *testing.T, out chan Event, deadline time.Duration) []Event {
	t.Helper()
	var got []Event
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case e := <-out:
			got = append(got, e)
		case <-timer.C:
			return got
		}
	}
}

func TestWatcherEmitsEventsWithEndOfLineOffsets(t *testing.T) {
	path := writeJSONL(t, twoLines)
	w := New(func() string { return path }, 0)
	w.SetInterval(5 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	out := make(chan Event, 8)
	go w.Run(ctx, out)

	got := drain(t, out, 60*time.Millisecond)
	if len(got) != 2 {
		t.Fatalf("want 2 events, got %d", len(got))
	}
	if got[0].Message == nil || got[0].Message.UUID != "u1" {
		t.Fatalf("event 0 wrong: %+v", got[0])
	}
	if got[1].Message == nil || got[1].Message.UUID != "u2" {
		t.Fatalf("event 1 wrong: %+v", got[1])
	}
	// IDs are strictly monotonic and equal end-of-line file offsets.
	if got[0].ID <= 0 || got[1].ID <= got[0].ID {
		t.Fatalf("ids should be strictly increasing, got %d then %d", got[0].ID, got[1].ID)
	}
	if got[1].ID != int64(len(twoLines)) {
		t.Fatalf("last event ID should equal file length %d, got %d", len(twoLines), got[1].ID)
	}
}

func TestWatcherResumesFromOffsetWithoutDupesOrSkips(t *testing.T) {
	path := writeJSONL(t, twoLines)

	// First watcher consumes line 1 only, records the ID it saw.
	w1 := New(func() string { return path }, 0)
	w1.SetInterval(5 * time.Millisecond)
	ctx1, cancel1 := context.WithCancel(context.Background())
	out1 := make(chan Event, 8)
	go w1.Run(ctx1, out1)
	first := <-out1
	cancel1()

	// Second watcher resumes at that offset — must emit ONLY line 2, no line 1.
	w2 := New(func() string { return path }, first.ID)
	w2.SetInterval(5 * time.Millisecond)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	out2 := make(chan Event, 8)
	go w2.Run(ctx2, out2)

	got := drain(t, out2, 60*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("resume must emit exactly one event, got %d", len(got))
	}
	if got[0].Message == nil || got[0].Message.UUID != "u2" {
		t.Fatalf("resumed event wrong: %+v", got[0])
	}
	if got[0].ID <= first.ID {
		t.Fatalf("resumed event ID %d must be strictly greater than first ID %d", got[0].ID, first.ID)
	}
}

func TestWatcherPartialTrailingLineIsBuffered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")

	// Write one full line and one partial (no trailing newline).
	partial := `{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}` + "\n" +
		`{"type":"assistant","uuid":"u2","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"y"}]`
	if err := os.WriteFile(path, []byte(partial), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	w := New(func() string { return path }, 0)
	w.SetInterval(5 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan Event, 8)
	go w.Run(ctx, out)

	got := drain(t, out, 30*time.Millisecond)
	if len(got) != 1 || got[0].Message.UUID != "u1" {
		t.Fatalf("only the complete line should emit; got %+v", got)
	}

	// Complete the partial line — the previously-buffered content plus new bytes
	// must decode into one more event.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	if _, err := f.WriteString("}}\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	_ = f.Close()

	got2 := drain(t, out, 60*time.Millisecond)
	if len(got2) != 1 || got2[0].Message.UUID != "u2" {
		t.Fatalf("completing the partial line should emit its event; got %+v", got2)
	}
}

func TestWatcherIgnoresAppInternalRecords(t *testing.T) {
	body := `{"type":"queue-operation","uuid":"x","message":{"role":"user","content":[]}}
{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"ai-title","uuid":"y","message":{"role":"assistant","content":[]}}
`
	path := writeJSONL(t, body)
	w := New(func() string { return path }, 0)
	w.SetInterval(5 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan Event, 8)
	go w.Run(ctx, out)

	got := drain(t, out, 30*time.Millisecond)
	if len(got) != 1 || got[0].Message.UUID != "u1" {
		t.Fatalf("app-internal records must be ignored; got %+v", got)
	}
}

func TestWatcherWaitsForFileToAppear(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "not-yet.jsonl")

	// pathFn returns "" until we flip the switch — models Claude not having
	// written its JSONL yet at connect time.
	var mu sync.Mutex
	visible := false
	pathFn := func() string {
		mu.Lock()
		defer mu.Unlock()
		if !visible {
			return ""
		}
		return path
	}

	w := New(pathFn, 0)
	w.SetInterval(5 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan Event, 8)
	go w.Run(ctx, out)

	// No file → no events.
	if got := drain(t, out, 20*time.Millisecond); len(got) != 0 {
		t.Fatalf("watcher should be idle before file exists, got %+v", got)
	}

	if err := os.WriteFile(path, []byte(twoLines), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	mu.Lock()
	visible = true
	mu.Unlock()

	got := drain(t, out, 60*time.Millisecond)
	if len(got) != 2 {
		t.Fatalf("watcher must pick up newly-appearing file; got %d events", len(got))
	}
}
