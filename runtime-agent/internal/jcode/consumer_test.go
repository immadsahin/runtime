package jcode

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func fixedClock() func() time.Time {
	return func() time.Time { return time.Unix(0, 0).UTC() }
}

func TestConsumerWritesOneRecordPerTurn(t *testing.T) {
	var buf bytes.Buffer
	sc := NewSessionConsumer("s", &buf, fixedClock())

	for _, f := range []Frame{
		evt(EvTextDelta, "s", map[string]any{"text": "hello"}),
		evt(EvTurnDone, "s", nil),
	} {
		if err := sc.Handle(f); err != nil {
			t.Fatalf("handle: %v", err)
		}
	}

	lines := nonEmptyLines(buf.String())
	if len(lines) != 1 {
		t.Fatalf("want 1 record, got %d: %q", len(lines), buf.String())
	}
	if !strings.Contains(lines[0], `"hello"`) || !strings.Contains(lines[0], `"assistant"`) {
		t.Errorf("record missing content: %s", lines[0])
	}
}

func TestConsumerFlushesToolDoneAndStreams(t *testing.T) {
	var buf bytes.Buffer
	sc := NewSessionConsumer("s", &buf, fixedClock())

	// Partial text, then a streaming Flush should emit the in-progress turn.
	_ = sc.Handle(evt(EvTextDelta, "s", map[string]any{"text": "wo"}))
	if err := sc.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	// A second Flush with no change must NOT write again.
	if err := sc.Flush(); err != nil {
		t.Fatalf("flush2: %v", err)
	}
	if got := len(nonEmptyLines(buf.String())); got != 1 {
		t.Fatalf("want 1 line after idempotent flush, got %d", got)
	}

	// A tool completing writes immediately (before turn_done).
	_ = sc.Handle(evt(EvToolStart, "s", map[string]any{"call_id": "c1", "name": "Bash"}))
	_ = sc.Handle(evt(EvToolDone, "s", map[string]any{"call_id": "c1", "name": "Bash", "output": "ok"}))
	if got := len(nonEmptyLines(buf.String())); got != 2 {
		t.Fatalf("want 2 lines after tool_done, got %d", got)
	}
}

func TestConsumerIgnoresOtherSessions(t *testing.T) {
	var buf bytes.Buffer
	sc := NewSessionConsumer("mine", &buf, fixedClock())

	_ = sc.Handle(evt(EvTextDelta, "other", map[string]any{"text": "not mine"}))
	_ = sc.Handle(evt(EvTurnDone, "other", nil))
	if buf.Len() != 0 {
		t.Errorf("consumer wrote records for a foreign session: %q", buf.String())
	}
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}
