package cast

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// pane is the tmux pane the recorder taps. Behind an interface so the recorder's
// FIFO/drain lifecycle is testable without a real tmux server.
type pane interface {
	// size reports the pane's current cols/rows for the cast header.
	size(ctx context.Context) (cols, rows int, err error)
	// arm starts piping the pane's output into the FIFO at fifoPath.
	arm(ctx context.Context, fifoPath string) error
	// disarm stops the pipe. Safe to call more than once.
	disarm(ctx context.Context) error
}

// pollInterval is how long the drain goroutine sleeps when the FIFO has no data
// available, before polling again (and re-checking for a stop request). Only
// hit during idle gaps — active output is read as fast as it arrives — so it
// costs nothing during a busy session and doesn't distort frame timing.
const pollInterval = 20 * time.Millisecond

// Recorder captures one tmux pane to an asciinema v2 cast file for its lifetime.
type Recorder struct {
	pane     pane
	castPath string
	opts     Options

	mu       sync.Mutex
	started  bool
	fifoPath string
	fifo     *os.File
	file     *os.File
	cw       *Writer
	wg       sync.WaitGroup
	stopping atomic.Bool

	// discarding flips true if writing the cast fails; the drain goroutine then
	// keeps reading (and dropping) so the pane is never back-pressured.
	discarding bool
	recordErr  error
}

// NewRecorder records the pane of tmux session `sessionName` to castPath.
func NewRecorder(sessionName, castPath string, opts Options) *Recorder {
	return &Recorder{pane: &tmuxPane{session: sessionName}, castPath: castPath, opts: opts}
}

// NewSessionRecorder records a session's pane to `<dir>/session.cast`.
func NewSessionRecorder(sessionName, dir string, opts Options) *Recorder {
	return NewRecorder(sessionName, filepath.Join(dir, DefaultCastName), opts)
}

// Start opens the cast file and FIFO, begins draining, and arms the pane pipe.
// Idempotent: a second call while recording is a no-op.
func (r *Recorder) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return nil
	}

	opts := r.opts
	if cols, rows, err := r.pane.size(ctx); err == nil {
		opts.Width, opts.Height = cols, rows
	}

	if err := os.MkdirAll(filepath.Dir(r.castPath), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(r.castPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	cw, err := NewWriter(file, opts)
	if err != nil {
		file.Close()
		return err
	}

	fifoPath := r.castPath + ".pipe"
	_ = os.Remove(fifoPath)
	if err := syscall.Mkfifo(fifoPath, 0o600); err != nil {
		file.Close()
		return err
	}
	// O_RDWR keeps a writer end permanently open, so reads do not see spurious
	// EOF between pane bursts, and opening the FIFO never blocks. O_NONBLOCK
	// lets drain observe idle periods and the stop signal without waiting for a
	// later pane write.
	fifo, err := os.OpenFile(fifoPath, os.O_RDWR|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		os.Remove(fifoPath)
		file.Close()
		return err
	}

	r.file, r.cw, r.fifo, r.fifoPath = file, cw, fifo, fifoPath
	r.stopping.Store(false)
	r.wg.Add(1)
	go r.drain()

	if err := r.pane.arm(ctx, fifoPath); err != nil {
		// Unwind: stop the goroutine and clean up.
		r.mu.Unlock()
		_ = r.stop(ctx)
		r.mu.Lock()
		return err
	}
	r.started = true
	return nil
}

// drain reads framed pane output from the non-blocking FIFO until Stop signals.
// A non-blocking read + sleep-on-EAGAIN loop is used deliberately: macOS/BSD
// support neither read deadlines on FIFOs nor reliable close-unblocks-read, so
// this is the portable way to stay interruptible. On a stop signal it finishes
// the pane's buffered tail (reads until EAGAIN) then exits. On a cast write
// error it detaches the pipe and discard-drains so the live terminal is never
// blocked.
func (r *Recorder) drain() {
	defer r.wg.Done()
	buf := make([]byte, 32*1024)
	conn, err := r.fifo.SyscallConn()
	if err != nil {
		return
	}
	for {
		n, err := readNonblocking(conn, buf)
		if n > 0 {
			r.consume(buf[:n])
		}
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) {
				// No data right now: exit once Stop has asked, else back off.
				if r.stopping.Load() {
					return
				}
				time.Sleep(pollInterval)
				continue
			}
			return // EOF (all writers gone) or a genuine read error.
		}
	}
}

// readNonblocking bypasses os.File.Read's poller, which waits for FIFO data
// after an EAGAIN even when the descriptor was opened O_NONBLOCK. Control
// keeps the descriptor open for the syscall without changing its mode, unlike
// File.Fd.
func readNonblocking(conn syscall.RawConn, buf []byte) (n int, readErr error) {
	err := conn.Control(func(fd uintptr) {
		n, readErr = syscall.Read(int(fd), buf)
	})
	if err != nil {
		return 0, err
	}
	return n, readErr
}

func (r *Recorder) consume(b []byte) {
	r.mu.Lock()
	discarding := r.discarding
	r.mu.Unlock()
	if discarding {
		return
	}
	if _, err := r.cw.Write(b); err != nil {
		r.mu.Lock()
		r.discarding = true
		r.recordErr = err
		r.mu.Unlock()
		// Detach the pipe so tmux stops feeding the (now-unread) FIFO; keep
		// draining below so `cat` never blocks the pane.
		_ = r.pane.disarm(context.Background())
	}
}

// Stop detaches the pipe, drains the tail, finalizes the cast, and cleans up.
// Idempotent.
func (r *Recorder) Stop(ctx context.Context) error {
	r.mu.Lock()
	if !r.started {
		r.mu.Unlock()
		return nil
	}
	r.mu.Unlock()
	return r.stop(ctx)
}

func (r *Recorder) stop(ctx context.Context) error {
	// Detach first so no new bytes arrive, then ask the drain goroutine to exit
	// once it has consumed the pane's buffered tail.
	_ = r.pane.disarm(ctx)
	r.stopping.Store(true)
	r.wg.Wait()

	r.mu.Lock()
	fifo, file, cw := r.fifo, r.file, r.cw
	r.fifo, r.file, r.cw = nil, nil, nil
	r.started = false
	fifoPath := r.fifoPath
	r.mu.Unlock()

	if fifo != nil {
		_ = fifo.Close()
	}

	var err error
	if cw != nil {
		err = cw.Close()
	}
	if file != nil {
		_ = file.Sync()
		_ = file.Close()
	}
	if fifoPath != "" {
		_ = os.Remove(fifoPath)
	}
	if err == nil {
		err = r.recordErr
	}
	return err
}

// Err returns the recording error, if the cast write failed mid-session.
func (r *Recorder) Err() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.recordErr
}

var _ io.Writer = (*Writer)(nil)
