package ptyx

import (
	"sync"
	"time"
)

// Coalescer buffers PTY bytes and emits them as `output` frames on a short
// interval or when the buffer fills, whichever comes first. The frozen wire
// contract requires `output` be coalesced; without this, one keystroke = one
// WS frame and the terminal floods with tiny writes.
//
// A Coalescer belongs to one connection: seq is per-socket and monotonic.
// Flush is called on the caller's goroutine (either by Write hitting the
// threshold or by the run loop's ticker).
type Coalescer struct {
	interval  time.Duration
	threshold int
	send      func(seq int, data []byte) error

	mu   sync.Mutex
	buf  []byte
	seq  int
	done chan struct{}
}

// NewCoalescer returns a Coalescer flushing at max(interval, threshold-bytes).
// Interval of 16ms + 4KB threshold matches ~60fps terminals without inflating
// per-frame overhead on bursty output.
func NewCoalescer(interval time.Duration, threshold int, send func(seq int, data []byte) error) *Coalescer {
	return &Coalescer{
		interval:  interval,
		threshold: threshold,
		send:      send,
		done:      make(chan struct{}),
	}
}

// Run drives the flush ticker until Stop is called. Blocks; callers usually
// launch this in its own goroutine.
func (c *Coalescer) Run() {
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			c.flush()
			return
		case <-t.C:
			c.flush()
		}
	}
}

// Write appends bytes to the coalescer's buffer. If the buffer meets or
// exceeds the threshold, it flushes immediately on the caller's goroutine so
// bursty output doesn't wait for the tick.
func (c *Coalescer) Write(b []byte) error {
	c.mu.Lock()
	c.buf = append(c.buf, b...)
	over := len(c.buf) >= c.threshold
	c.mu.Unlock()
	if over {
		return c.flush()
	}
	return nil
}

// NextSeq reserves and returns the next per-socket sequence number. The server
// uses it for the final redactor-flush frame emitted after Stop, so that frame
// stays monotonic with the coalesced output stream rather than reusing seq 0.
func (c *Coalescer) NextSeq() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	seq := c.seq
	c.seq++
	return seq
}

// Stop tells Run to exit after one last flush.
func (c *Coalescer) Stop() {
	select {
	case <-c.done:
		return
	default:
	}
	close(c.done)
}

func (c *Coalescer) flush() error {
	c.mu.Lock()
	if len(c.buf) == 0 {
		c.mu.Unlock()
		return nil
	}
	data := c.buf
	c.buf = nil
	seq := c.seq
	c.seq++
	c.mu.Unlock()
	return c.send(seq, data)
}
