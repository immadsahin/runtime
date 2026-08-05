package ptyx

import (
	"sync"
	"testing"
)

// recorder captures every role notification the broker delivers for a client.
type recorder struct {
	mu    sync.Mutex
	roles []bool
}

func (r *recorder) set(w bool) {
	r.mu.Lock()
	r.roles = append(r.roles, w)
	r.mu.Unlock()
}

func (r *recorder) snapshot() []bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]bool, len(r.roles))
	copy(out, r.roles)
	return out
}

func TestBrokerFirstAttachIsWriter(t *testing.T) {
	b := NewBroker()
	r := &recorder{}
	a := b.Attach("ws-1", r.set)
	if !a.IsWriter() {
		t.Fatal("first attach should be writer")
	}
	if got := r.snapshot(); len(got) != 1 || !got[0] {
		t.Fatalf("first attach should get one writer=true notification, got %v", got)
	}
}

func TestBrokerSecondAttachIsReader(t *testing.T) {
	b := NewBroker()
	r1, r2 := &recorder{}, &recorder{}
	a1 := b.Attach("ws-1", r1.set)
	a2 := b.Attach("ws-1", r2.set)
	if !a1.IsWriter() {
		t.Fatal("first attach must remain writer")
	}
	if a2.IsWriter() {
		t.Fatal("second attach must be reader")
	}
	if got := r2.snapshot(); len(got) != 1 || got[0] {
		t.Fatalf("reader should get one writer=false notification, got %v", got)
	}
}

func TestBrokerPromotesFirstReaderOnWriterDetach(t *testing.T) {
	b := NewBroker()
	r1, r2, r3 := &recorder{}, &recorder{}, &recorder{}
	a1 := b.Attach("ws-1", r1.set)
	a2 := b.Attach("ws-1", r2.set)
	a3 := b.Attach("ws-1", r3.set)

	a1.Detach()

	if a2.IsWriter() != true {
		t.Fatal("first reader should be promoted after writer detach")
	}
	if a3.IsWriter() != false {
		t.Fatal("second reader must stay reader")
	}
	if got := r2.snapshot(); len(got) != 2 || got[0] || !got[1] {
		t.Fatalf("promoted reader should get writer=false then writer=true, got %v", got)
	}
	if got := r3.snapshot(); len(got) != 1 || got[0] {
		t.Fatalf("non-promoted reader should still have writer=false only, got %v", got)
	}
}

func TestBrokerReaderDetachDoesNotPromote(t *testing.T) {
	b := NewBroker()
	r1, r2 := &recorder{}, &recorder{}
	a1 := b.Attach("ws-1", r1.set)
	a2 := b.Attach("ws-1", r2.set)

	a2.Detach()

	if !a1.IsWriter() {
		t.Fatal("writer must remain writer after reader detach")
	}
	if got := r1.snapshot(); len(got) != 1 || !got[0] {
		t.Fatalf("writer should not be re-notified when a reader detaches, got %v", got)
	}
}

func TestBrokerIsolatesWorkspaces(t *testing.T) {
	b := NewBroker()
	r1, r2 := &recorder{}, &recorder{}
	a1 := b.Attach("ws-A", r1.set)
	a2 := b.Attach("ws-B", r2.set)
	if !a1.IsWriter() || !a2.IsWriter() {
		t.Fatal("first attach in each workspace should be its own writer")
	}
}

func TestBrokerNextAttachAfterEmptyIsWriter(t *testing.T) {
	b := NewBroker()
	r1, r2 := &recorder{}, &recorder{}
	a1 := b.Attach("ws-1", r1.set)
	a1.Detach()
	a2 := b.Attach("ws-1", r2.set)
	if !a2.IsWriter() {
		t.Fatal("after all clients leave, next attach should be writer")
	}
}
