package jcode

import (
	"io"
	"time"
)

// SessionConsumer turns one session's event frames into conversation records
// appended to w (the workspace's conversation log the SSE pipeline tails). It
// owns the assembler and the emit policy:
//
//   - a completed turn (turn_done) is written and the assembler reset;
//   - a completed tool call (tool_done) is written immediately, so a tool result
//     appears without waiting for the whole turn to finish;
//   - Flush writes the in-progress turn, so a caller polling on a timer streams
//     partial text (same uuid each time; the UI upserts by uuid).
//
// Frames for other sessions are ignored, so one demux loop can Handle every
// frame from a multiplexed client and let each consumer pick out its own. Not
// safe for concurrent use — one consumer is driven by one demux goroutine.
type SessionConsumer struct {
	sessionID string
	conv      *Conversation
	w         io.Writer
	dirty     bool
}

// NewSessionConsumer builds a consumer that writes sessionID's records to w.
func NewSessionConsumer(sessionID string, w io.Writer, clock func() time.Time) *SessionConsumer {
	return &SessionConsumer{
		sessionID: sessionID,
		conv:      NewConversation(sessionID, clock),
		w:         w,
	}
}

// Handle folds one frame into the session and writes a record at turn and tool
// boundaries. Frames addressed to a different session are ignored.
func (sc *SessionConsumer) Handle(f Frame) error {
	if f.SessionID != sc.sessionID {
		return nil
	}
	turnComplete := sc.conv.Apply(f)
	sc.dirty = true
	switch {
	case turnComplete:
		err := sc.write()
		sc.conv.Reset()
		return err
	case f.Ev == EvToolDone:
		return sc.write()
	}
	return nil
}

// Flush writes the current in-progress turn if it changed since the last write.
// Called on a timer to stream partial assistant text between boundaries.
func (sc *SessionConsumer) Flush() error {
	if !sc.dirty {
		return nil
	}
	return sc.write()
}

// write appends the current record, if any, and clears the dirty flag.
func (sc *SessionConsumer) write() error {
	sc.dirty = false
	rec := sc.conv.Record()
	if rec == nil {
		return nil
	}
	_, err := sc.w.Write(rec)
	return err
}
