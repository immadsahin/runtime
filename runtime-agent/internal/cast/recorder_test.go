package cast

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakePane emulates tmux: on arm it writes canned bytes into the FIFO (as
// pipe-pane's `cat` would) and records whether it was disarmed.
type fakePane struct {
	data       []byte
	cols, rows int

	mu       sync.Mutex
	armed    bool
	disarmed bool
}

func (p *fakePane) size(context.Context) (int, int, error) {
	if p.cols == 0 {
		return 100, 30, nil
	}
	return p.cols, p.rows, nil
}

func (p *fakePane) arm(_ context.Context, fifoPath string) error {
	p.mu.Lock()
	p.armed = true
	p.mu.Unlock()
	go func() {
		w, err := os.OpenFile(fifoPath, os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		defer w.Close()
		w.Write(p.data)
	}()
	return nil
}

func (p *fakePane) disarm(context.Context) error {
	p.mu.Lock()
	p.disarmed = true
	p.mu.Unlock()
	return nil
}

func newFakeRecorder(t *testing.T, p pane) *Recorder {
	t.Helper()
	castPath := filepath.Join(t.TempDir(), DefaultCastName)
	return &Recorder{pane: p, castPath: castPath}
}

func TestRecorderCapturesPaneOutput(t *testing.T) {
	p := &fakePane{data: []byte("hello CAST_OK world"), cols: 90, rows: 25}
	r := newFakeRecorder(t, p)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // let the drain goroutine consume
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(r.castPath)
	if err != nil {
		t.Fatal(err)
	}
	h, frames := parseCast(t, b)
	if h.Width != 90 || h.Height != 25 {
		t.Fatalf("header size = %dx%d, want 90x25 (from pane)", h.Width, h.Height)
	}
	var out bytes.Buffer
	for _, f := range frames {
		out.WriteString(f[2].(string))
	}
	if !bytes.Contains(out.Bytes(), []byte("CAST_OK")) {
		t.Fatalf("cast missing pane output; got %q", out.String())
	}
	if !p.disarmed {
		t.Fatal("expected pane to be disarmed on Stop")
	}
	if r.Err() != nil {
		t.Fatalf("unexpected record error: %v", r.Err())
	}
}

func TestRecorderStartStopIdempotent(t *testing.T) {
	p := &fakePane{data: []byte("x")}
	r := newFakeRecorder(t, p)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil { // second Start is a no-op
		t.Fatal(err)
	}
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Stop(context.Background()); err != nil { // second Stop is a no-op
		t.Fatal(err)
	}
}
