package ptyx

import (
	"sync"
)

// Broker enforces the single-writer rule for a workspace's PTY: the first
// WebSocket to attach becomes the writer (its keystrokes reach tmux); further
// attaches are read-only. If the writer disconnects, the oldest waiting reader
// is promoted and notified via its RoleFunc.
//
// All connections still see PTY output (tmux fans it out to every attached
// client); the broker only gates whose input frames the server forwards.
type Broker struct {
	mu       sync.Mutex
	sessions map[string]*brokerSession
}

// RoleFunc is invoked whenever a client's writer status changes. Called under
// the broker lock, so it must not block on I/O — hand off to the WS's own
// goroutine before writing frames.
type RoleFunc func(writer bool)

type brokerSession struct {
	writer  *client
	readers []*client // FIFO; first is promoted on writer disconnect
}

type client struct {
	setRole RoleFunc
}

func NewBroker() *Broker {
	return &Broker{sessions: make(map[string]*brokerSession)}
}

// Attach registers a new connection for the workspace and returns a handle
// that reports whether this client currently holds the writer role plus a
// Detach func to be called when the connection closes.
type Attachment struct {
	IsWriter func() bool
	Detach   func()
}

// Attach records a client and immediately calls setRole with its initial role.
// setRole may later be called again (from the promoting goroutine) if this
// client is a reader that later becomes the writer.
func (b *Broker) Attach(workspaceID string, setRole RoleFunc) *Attachment {
	b.mu.Lock()
	sess, ok := b.sessions[workspaceID]
	if !ok {
		sess = &brokerSession{}
		b.sessions[workspaceID] = sess
	}
	c := &client{setRole: setRole}
	isWriter := false
	if sess.writer == nil {
		sess.writer = c
		isWriter = true
	} else {
		sess.readers = append(sess.readers, c)
	}
	b.mu.Unlock()

	setRole(isWriter)

	return &Attachment{
		IsWriter: func() bool {
			b.mu.Lock()
			defer b.mu.Unlock()
			s, ok := b.sessions[workspaceID]
			return ok && s.writer == c
		},
		Detach: func() { b.detach(workspaceID, c) },
	}
}

func (b *Broker) detach(workspaceID string, c *client) {
	b.mu.Lock()
	sess, ok := b.sessions[workspaceID]
	if !ok {
		b.mu.Unlock()
		return
	}

	var promoted *client
	if sess.writer == c {
		if len(sess.readers) > 0 {
			promoted = sess.readers[0]
			sess.readers = sess.readers[1:]
			sess.writer = promoted
		} else {
			sess.writer = nil
		}
	} else {
		for i, r := range sess.readers {
			if r == c {
				sess.readers = append(sess.readers[:i], sess.readers[i+1:]...)
				break
			}
		}
	}
	if sess.writer == nil && len(sess.readers) == 0 {
		delete(b.sessions, workspaceID)
	}
	b.mu.Unlock()

	if promoted != nil {
		promoted.setRole(true)
	}
}
