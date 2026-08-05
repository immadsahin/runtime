package ptyx

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu     sync.Mutex
	frames [][]byte
	seqs   []int
}

func (s *sink) recv(seq int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	s.frames = append(s.frames, cp)
	s.seqs = append(s.seqs, seq)
	return nil
}

func (s *sink) snapshot() ([][]byte, []int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := make([][]byte, len(s.frames))
	copy(f, s.frames)
	q := make([]int, len(s.seqs))
	copy(q, s.seqs)
	return f, q
}

func TestCoalescerFlushesOnTick(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(5*time.Millisecond, 4096, s.recv)
	go c.Run()
	defer c.Stop()

	_ = c.Write([]byte("hello "))
	_ = c.Write([]byte("world"))

	// wait past a few ticks
	time.Sleep(30 * time.Millisecond)

	frames, seqs := s.snapshot()
	if len(frames) == 0 {
		t.Fatal("expected at least one flush")
	}
	// concatenation of frames == concatenation of writes
	joined := bytes.Join(frames, nil)
	if string(joined) != "hello world" {
		t.Fatalf("expected 'hello world', got %q", string(joined))
	}
	// seq must be strictly monotonic starting at 0
	for i, q := range seqs {
		if q != i {
			t.Fatalf("seq[%d] = %d, want %d (seqs=%v)", i, q, i, seqs)
		}
	}
}

func TestCoalescerFlushesOnThreshold(t *testing.T) {
	s := &sink{}
	// Big interval so only threshold can trigger.
	c := NewCoalescer(10*time.Second, 8, s.recv)
	go c.Run()
	defer c.Stop()

	_ = c.Write([]byte("12345678")) // hits threshold exactly
	time.Sleep(20 * time.Millisecond)

	frames, _ := s.snapshot()
	if len(frames) != 1 || string(frames[0]) != "12345678" {
		t.Fatalf("expected one 8-byte flush, got %v", frames)
	}
}

func TestCoalescerEmptyTickDoesNotFlush(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(5*time.Millisecond, 4096, s.recv)
	go c.Run()
	defer c.Stop()

	time.Sleep(30 * time.Millisecond)

	frames, _ := s.snapshot()
	if len(frames) != 0 {
		t.Fatalf("empty ticker should not emit frames, got %v", frames)
	}
}

func TestCoalescerStopFlushesRemainder(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(10*time.Second, 4096, s.recv)
	done := make(chan struct{})
	go func() { c.Run(); close(done) }()

	_ = c.Write([]byte("tail"))
	c.Stop()
	<-done

	frames, _ := s.snapshot()
	if len(frames) != 1 || string(frames[0]) != "tail" {
		t.Fatalf("stop should flush pending bytes, got %v", frames)
	}
}
