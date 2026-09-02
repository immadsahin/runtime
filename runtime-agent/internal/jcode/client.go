package jcode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// defaultRequestTimeout bounds a request that expects a reply (hello, create_
// session, cancel). The stream is the source of truth for everything else, so
// only request/reply calls use it. Mirrors the SDK's 30s default.
const defaultRequestTimeout = 30 * time.Second

// eventsBuffer is how many stream events may queue before the read loop blocks
// on the consumer. The translator drains continuously, so this only absorbs
// bursts; a full buffer applies backpressure rather than dropping events.
const eventsBuffer = 1024

// Client is a connection to one `jcode api-bridge` over its NDJSON Unix socket.
// One bridge (one per cloud computer) serves many sessions, so a single Client
// multiplexes them: stream events carry SessionID and are fanned out by the
// consumer. The client is safe for concurrent use.
type Client struct {
	conn   net.Conn
	writer *bufio.Writer

	writeMu sync.Mutex // serializes frame writes

	mu       sync.Mutex // guards nextID, pending, closed, closeErr
	nextID   int
	pending  map[int]chan Frame
	closed   bool
	closeErr error

	events   chan Frame
	stop     chan struct{} // closed once, unblocks a dispatch send after teardown
	stopOnce sync.Once

	// server and capabilities come from the handshake and are read-only after
	// Dial returns, so they need no lock.
	server       string
	capabilities []string
}

// outgoing is the on-wire request envelope: `{v, id, ...request}`. Request is
// embedded so its tagged fields are promoted to the top-level object, matching
// the SDK's encodeFrame({ v, id, ...request }).
type outgoing struct {
	V  int `json:"v"`
	ID int `json:"id"`
	Request
}

// Dial connects to the bridge at socketPath, performs the version handshake,
// and starts the read loop. clientName identifies Runtime in the handshake.
func Dial(ctx context.Context, socketPath, clientName string) (*Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("jcode: dial %s: %w (is `jcode api-bridge` running?)", socketPath, err)
	}
	return handshake(ctx, newClient(conn), clientName)
}

// newClient wraps an established connection and starts its read loop. Split
// from Dial so tests can drive the client over net.Pipe.
func newClient(conn net.Conn) *Client {
	c := &Client{
		conn:    conn,
		writer:  bufio.NewWriter(conn),
		pending: make(map[int]chan Frame),
		events:  make(chan Frame, eventsBuffer),
		stop:    make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// handshake performs the hello exchange and records the server's identity and
// capabilities. On any failure it closes the client.
func handshake(ctx context.Context, c *Client, clientName string) (*Client, error) {
	if clientName == "" {
		clientName = "runtime-agent"
	}
	frame, err := c.request(ctx, Request{
		Req:        ReqHello,
		MinVersion: APIVersionMajor,
		MaxVersion: APIVersionMajor,
		Client:     clientName,
	})
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("jcode: handshake: %w", err)
	}
	if frame.Ev != EvHelloOK {
		c.Close()
		return nil, fmt.Errorf("jcode: handshake: unexpected reply %q: %s", frame.Ev, frame.Message)
	}
	var hello HelloOK
	if err := frame.Into(&hello); err != nil {
		c.Close()
		return nil, fmt.Errorf("jcode: handshake decode: %w", err)
	}
	c.server = hello.Server
	c.capabilities = hello.Capabilities
	return c, nil
}

// Server returns the bridge's identity from the handshake.
func (c *Client) Server() string { return c.server }

// Supports reports whether the bridge advertised a capability. The current
// bridge omits "permissions" (it never prompts), so callers must check before
// waiting on a permission_request.
func (c *Client) Supports(capability string) bool {
	for _, cap := range c.capabilities {
		if cap == capability {
			return true
		}
	}
	return false
}

// Events is the stream of unsolicited events (text_delta, tool_*, token_usage,
// turn_done, ...). It closes when the connection ends. The consumer must drain
// it continuously; a stalled consumer applies backpressure to the read loop.
func (c *Client) Events() <-chan Frame { return c.events }

// CreateSession opens a new jcode session rooted at workingDir (the worktree)
// and returns its info. Replies with an `attached` frame.
func (c *Client) CreateSession(ctx context.Context, workingDir string) (SessionInfo, error) {
	return c.attachReply(ctx, Request{Req: ReqCreateSession, WorkingDir: workingDir})
}

// AttachSession re-attaches to an existing session (e.g. after a reconnect).
func (c *Client) AttachSession(ctx context.Context, sessionID string) (SessionInfo, error) {
	return c.attachReply(ctx, Request{Req: ReqAttachSession, SessionID: sessionID})
}

// attachReply runs a request whose success reply is an `attached` frame and
// returns the session it carries. create_session and attach_session share it.
func (c *Client) attachReply(ctx context.Context, req Request) (SessionInfo, error) {
	frame, err := c.requestOK(ctx, req)
	if err != nil {
		return SessionInfo{}, err
	}
	if frame.Ev != EvAttached {
		return SessionInfo{}, fmt.Errorf("jcode: %s: expected attached, got %q", req.Req, frame.Ev)
	}
	var a Attached
	if err := frame.Into(&a); err != nil {
		return SessionInfo{}, fmt.Errorf("jcode: %s decode: %w", req.Req, err)
	}
	return a.Session, nil
}

// SendMessage delivers a user prompt to a session, starting a model turn. The
// bridge does not reply at the request level — it acknowledges with a
// message_accepted stream event — so this is fire-and-forget; the caller
// observes progress on Events. Replaces typing into a PTY.
func (c *Client) SendMessage(sessionID, content string) error {
	return c.notify(Request{Req: ReqSendMessage, SessionID: sessionID, Content: content})
}

// Cancel interrupts the current turn in a session.
func (c *Client) Cancel(ctx context.Context, sessionID string) error {
	_, err := c.requestOK(ctx, Request{Req: ReqCancel, SessionID: sessionID})
	return err
}

// RespondPermission answers a permission_request. Only meaningful when the
// bridge advertises the "permissions" capability.
func (c *Client) RespondPermission(sessionID, requestID, decision string) error {
	return c.notify(Request{
		Req:       ReqPermissionResponse,
		SessionID: sessionID,
		RequestID: requestID,
		Decision:  decision,
	})
}

// requestOK sends a request expecting a reply and turns an `error` reply frame
// into a Go error, so callers handle only their success shape.
func (c *Client) requestOK(ctx context.Context, req Request) (Frame, error) {
	frame, err := c.request(ctx, req)
	if err != nil {
		return Frame{}, err
	}
	if frame.Ev == EvError {
		return Frame{}, fmt.Errorf("jcode: %s: %s (%s)", req.Req, frame.Message, frame.Code)
	}
	return frame, nil
}

// request sends a request and waits for the reply frame the server correlates
// by echoing reply_to. It bounds the wait by ctx and defaultRequestTimeout.
func (c *Client) request(ctx context.Context, req Request) (Frame, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return Frame{}, c.closedErr()
	}
	id := c.nextID
	c.nextID++
	ch := make(chan Frame, 1) // buffered so the read loop never blocks delivering
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.writeFrame(id, req); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return Frame{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, defaultRequestTimeout)
	defer cancel()
	select {
	case frame, ok := <-ch:
		if !ok {
			// shutdown closed the waiter: the connection died mid-request.
			return Frame{}, c.closedErr()
		}
		return frame, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return Frame{}, fmt.Errorf("jcode: %s: %w", req.Req, ctx.Err())
	}
}

// notify writes a request without registering a waiter (fire-and-forget).
func (c *Client) notify(req Request) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return c.closedErr()
	}
	id := c.nextID
	c.nextID++
	c.mu.Unlock()
	return c.writeFrame(id, req)
}

// writeFrame marshals `{v, id, ...req}` and writes it as one NDJSON line.
func (c *Client) writeFrame(id int, req Request) error {
	line, err := json.Marshal(outgoing{V: APIVersionMajor, ID: id, Request: req})
	if err != nil {
		return fmt.Errorf("jcode: encode %s: %w", req.Req, err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.writer.Write(line); err != nil {
		return fmt.Errorf("jcode: write %s: %w", req.Req, err)
	}
	if err := c.writer.WriteByte('\n'); err != nil {
		return fmt.Errorf("jcode: write %s: %w", req.Req, err)
	}
	return c.writer.Flush()
}

// readLoop reads NDJSON lines until the connection ends. Replies (reply_to set)
// go to their waiter; everything else is a stream event. ReadBytes (not
// bufio.Scanner) is used so a large tool_done payload past Scanner's 64KB line
// cap does not truncate the stream.
func (c *Client) readLoop() {
	r := bufio.NewReader(c.conn)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			c.dispatch(line)
		}
		if err != nil {
			c.shutdown(err)
			return
		}
	}
}

// dispatch decodes one line and routes it to a waiter or the event stream.
func (c *Client) dispatch(line []byte) {
	var f Frame
	if err := json.Unmarshal(line, &f); err != nil {
		return // tolerate unparseable lines, matching the SDK/Rust reader
	}
	f.raw = line // ReadBytes returns a fresh slice, safe to retain

	if f.ReplyTo != nil {
		c.mu.Lock()
		ch, ok := c.pending[*f.ReplyTo]
		if ok {
			delete(c.pending, *f.ReplyTo)
		}
		c.mu.Unlock()
		if ok {
			ch <- f // buffered(1), never blocks
			return
		}
		// A reply whose waiter already timed out falls through to the stream;
		// the translator switches on Ev and ignores reply-shaped frames.
	}

	select {
	case c.events <- f:
	case <-c.stop: // consumer gone / connection torn down; do not block forever
	}
}

// shutdown fails all in-flight requests and closes the event stream exactly
// once. err is the read error that ended the connection (often io.EOF).
func (c *Client) shutdown(err error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if err != nil {
		c.closeErr = err
	}
	pending := c.pending
	c.pending = make(map[int]chan Frame)
	c.mu.Unlock()

	for _, ch := range pending {
		close(ch) // waiting request() sees ok=false and returns closedErr
	}
	c.signalStop()
	close(c.events)
	_ = c.conn.Close()
}

// signalStop closes the stop channel exactly once.
func (c *Client) signalStop() { c.stopOnce.Do(func() { close(c.stop) }) }

// Close shuts the connection down and releases the read loop. It signals stop
// first so a read loop blocked on a full event buffer unblocks, then closes the
// connection, which makes readLoop return and run shutdown.
func (c *Client) Close() error {
	c.signalStop()
	return c.conn.Close()
}

func (c *Client) closedErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closeErr != nil {
		return fmt.Errorf("jcode: connection closed: %w", c.closeErr)
	}
	return errors.New("jcode: client closed")
}
