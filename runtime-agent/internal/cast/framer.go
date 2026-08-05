package cast

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"time"
)

// Clock is the time source, injected so framing is deterministic under test.
type Clock interface{ Now() time.Time }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// defaultWindow coalesces output bytes arriving within this span into a single
// frame. Claude streams many tiny chunks; grouping them cuts frame count and
// write syscalls with no perceptible difference on replay.
const defaultWindow = 5 * time.Millisecond

// Options configure a Writer. Width/Height seed the asciinema header; Clock and
// Window default to the wall clock and defaultWindow when zero.
type Options struct {
	Width  int
	Height int
	Clock  Clock
	Window time.Duration
}

// Writer frames terminal output as an asciinema v2 stream (a header object line
// followed by `[elapsed, "o", data]` event lines). Safe for concurrent Write.
type Writer struct {
	mu     sync.Mutex
	w      *bufio.Writer
	clock  Clock
	window time.Duration
	start  time.Time

	pending      []byte
	pendingStart time.Time
	hasPending   bool
	err          error
}

type castHeader struct {
	Version   int   `json:"version"`
	Width     int   `json:"width"`
	Height    int   `json:"height"`
	Timestamp int64 `json:"timestamp"`
}

// NewWriter writes the asciinema v2 header to w and returns a framer. The caller
// owns w's lifecycle (NewWriter never closes it); call Flush/Close to drain.
func NewWriter(w io.Writer, opts Options) (*Writer, error) {
	clock := opts.Clock
	if clock == nil {
		clock = realClock{}
	}
	window := opts.Window
	if window <= 0 {
		window = defaultWindow
	}
	width, height := opts.Width, opts.Height
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	start := clock.Now()

	cw := &Writer{
		w:      bufio.NewWriter(w),
		clock:  clock,
		window: window,
		start:  start,
	}
	header, err := json.Marshal(castHeader{
		Version:   2,
		Width:     width,
		Height:    height,
		Timestamp: start.Unix(),
	})
	if err != nil {
		return nil, err
	}
	if _, err := cw.w.Write(append(header, '\n')); err != nil {
		return nil, err
	}
	return cw, nil
}

// Write records a chunk of terminal output as (part of) an output event. Chunks
// arriving within the coalescing window of the current frame's start are merged;
// once the window is crossed the pending frame is flushed and a new one begins.
func (cw *Writer) Write(p []byte) (int, error) {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	if cw.err != nil {
		return 0, cw.err
	}
	now := cw.clock.Now()
	if cw.hasPending && now.Sub(cw.pendingStart) >= cw.window {
		cw.flushLocked()
	}
	if !cw.hasPending {
		cw.hasPending = true
		cw.pendingStart = now
	}
	cw.pending = append(cw.pending, p...)
	return len(p), cw.err
}

func (cw *Writer) flushLocked() {
	if cw.err != nil || !cw.hasPending {
		return
	}
	elapsed := cw.pendingStart.Sub(cw.start).Seconds()
	if elapsed < 0 {
		elapsed = 0
	}
	frame, err := json.Marshal([]any{elapsed, "o", string(cw.pending)})
	if err != nil {
		cw.err = err
		return
	}
	if _, err := cw.w.Write(append(frame, '\n')); err != nil {
		cw.err = err
		return
	}
	cw.pending = cw.pending[:0]
	cw.hasPending = false
}

// Flush frames any pending output and flushes the buffered writer.
func (cw *Writer) Flush() error {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	cw.flushLocked()
	if cw.err != nil {
		return cw.err
	}
	return cw.w.Flush()
}

// Close flushes remaining output. It does not close the underlying writer.
func (cw *Writer) Close() error { return cw.Flush() }
