package cast

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// parseCast splits a cast into its header and output-event frames.
func parseCast(t *testing.T, b []byte) (castHeader, [][]any) {
	t.Helper()
	lines := bytes.Split(bytes.TrimRight(b, "\n"), []byte("\n"))
	if len(lines) == 0 {
		t.Fatal("empty cast")
	}
	var h castHeader
	if err := json.Unmarshal(lines[0], &h); err != nil {
		t.Fatalf("bad header %q: %v", lines[0], err)
	}
	var frames [][]any
	for _, line := range lines[1:] {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var f []any
		if err := json.Unmarshal(line, &f); err != nil {
			t.Fatalf("bad frame %q: %v", line, err)
		}
		frames = append(frames, f)
	}
	return h, frames
}

func TestWriterHeader(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	var buf bytes.Buffer
	cw, err := NewWriter(&buf, Options{Width: 120, Height: 40, Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	if err := cw.Close(); err != nil {
		t.Fatal(err)
	}
	h, frames := parseCast(t, buf.Bytes())
	if h.Version != 2 || h.Width != 120 || h.Height != 40 {
		t.Fatalf("unexpected header %+v", h)
	}
	if h.Timestamp != 1_700_000_000 {
		t.Fatalf("timestamp = %d", h.Timestamp)
	}
	if len(frames) != 0 {
		t.Fatalf("expected no frames, got %v", frames)
	}
}

func TestWriterDefaultsDimensions(t *testing.T) {
	var buf bytes.Buffer
	cw, err := NewWriter(&buf, Options{Clock: &fakeClock{t: time.Unix(0, 0)}})
	if err != nil {
		t.Fatal(err)
	}
	cw.Close()
	h, _ := parseCast(t, buf.Bytes())
	if h.Width != 80 || h.Height != 24 {
		t.Fatalf("expected 80x24 default, got %dx%d", h.Width, h.Height)
	}
}

func TestWriterCoalescesWithinWindow(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	var buf bytes.Buffer
	cw, err := NewWriter(&buf, Options{Clock: clock, Window: 5 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}

	cw.Write([]byte("a"))             // t=0: opens a frame
	clock.advance(1 * time.Millisecond)
	cw.Write([]byte("b"))             // t=1ms: within window -> same frame
	clock.advance(5 * time.Millisecond)
	cw.Write([]byte("c"))             // t=6ms: crosses window -> new frame
	cw.Close()

	_, frames := parseCast(t, buf.Bytes())
	if len(frames) != 2 {
		t.Fatalf("expected 2 frames, got %d: %v", len(frames), frames)
	}
	assertFrame(t, frames[0], 0, "ab")
	assertFrame(t, frames[1], 0.006, "c")
}

func TestWriterFramesAreMonotonic(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	var buf bytes.Buffer
	cw, _ := NewWriter(&buf, Options{Clock: clock, Window: time.Millisecond})
	for i := 0; i < 5; i++ {
		cw.Write([]byte("x"))
		clock.advance(2 * time.Millisecond)
	}
	cw.Close()
	_, frames := parseCast(t, buf.Bytes())
	prev := -1.0
	for _, f := range frames {
		e := f[0].(float64)
		if e < prev {
			t.Fatalf("non-monotonic elapsed: %v after %v", e, prev)
		}
		prev = e
	}
}

func assertFrame(t *testing.T, frame []any, wantElapsed float64, wantData string) {
	t.Helper()
	if len(frame) != 3 {
		t.Fatalf("frame arity: %v", frame)
	}
	if got := frame[0].(float64); got != wantElapsed {
		t.Fatalf("elapsed = %v, want %v", got, wantElapsed)
	}
	if frame[1].(string) != "o" {
		t.Fatalf("event type = %v, want o", frame[1])
	}
	if frame[2].(string) != wantData {
		t.Fatalf("data = %q, want %q", frame[2], wantData)
	}
}
