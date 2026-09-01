package jcode

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"
)

// fakeBridge speaks the server side of the harness protocol over conn: it
// answers hello and create_session with a reply_to-correlated frame, acks
// send_message with a stream event, and emits any scripted stream events right
// after the create_session reply. It is deliberately minimal — enough to
// exercise framing, reply correlation, and event dispatch end to end.
func fakeBridge(t *testing.T, conn net.Conn, streamAfterCreate []map[string]any) {
	t.Helper()
	r := bufio.NewReader(conn)
	write := func(m map[string]any) {
		b, err := json.Marshal(m)
		if err != nil {
			return
		}
		_, _ = conn.Write(append(b, '\n'))
	}
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var req map[string]any
		if json.Unmarshal(line, &req) != nil {
			continue
		}
		id := req["id"]
		switch req["req"] {
		case "hello":
			write(map[string]any{
				"reply_to": id, "ev": "hello_ok",
				"version": 1, "server": "fake/1", "capabilities": []string{"sessions"},
			})
		case "create_session":
			write(map[string]any{
				"reply_to": id, "ev": "attached",
				"session": map[string]any{
					"session_id": "sess-1", "working_dir": req["working_dir"], "status": "idle",
				},
			})
			for _, ev := range streamAfterCreate {
				write(ev)
			}
		case "send_message":
			write(map[string]any{"ev": "message_accepted", "session_id": req["session_id"]})
		}
	}
}

func TestClientHandshakeCreateAndStream(t *testing.T) {
	cli, srv := net.Pipe()
	stream := []map[string]any{
		{"ev": "text_delta", "session_id": "sess-1", "text": "hi"},
		{"ev": "tool_done", "session_id": "sess-1", "call_id": "c1", "name": "Bash", "output": "ok"},
		{"ev": "token_usage", "session_id": "sess-1", "input": 10, "output": 5, "cache_read_input": 2},
		{"ev": "turn_done", "session_id": "sess-1"},
	}
	go fakeBridge(t, srv, stream)

	ctx := context.Background()
	c, err := handshake(ctx, newClient(cli), "test")
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	defer c.Close()
	if c.Server() != "fake/1" {
		t.Errorf("server = %q, want fake/1", c.Server())
	}
	if !c.Supports("sessions") || c.Supports("permissions") {
		t.Errorf("capabilities wrong: sessions=%v permissions=%v",
			c.Supports("sessions"), c.Supports("permissions"))
	}

	sess, err := c.CreateSession(ctx, "/work")
	if err != nil {
		t.Fatalf("create_session: %v", err)
	}
	if sess.SessionID != "sess-1" || sess.WorkingDir != "/work" {
		t.Errorf("session = %+v", sess)
	}

	want := []string{"text_delta", "tool_done", "token_usage", "turn_done"}
	timeout := time.After(2 * time.Second)
	for i := 0; i < len(want); i++ {
		select {
		case f, ok := <-c.Events():
			if !ok {
				t.Fatalf("events closed early at %d", i)
			}
			if f.Ev != want[i] {
				t.Fatalf("event %d = %q, want %q", i, f.Ev, want[i])
			}
			if f.SessionID != "sess-1" {
				t.Errorf("event %d session = %q", i, f.SessionID)
			}
			// Spot-check that colliding "output" fields decode correctly per kind.
			switch f.Ev {
			case "tool_done":
				var td ToolDone
				if err := f.Into(&td); err != nil || td.Output != "ok" || td.Name != "Bash" {
					t.Errorf("tool_done decode: err=%v got=%+v", err, td)
				}
			case "token_usage":
				var tu TokenUsage
				if err := f.Into(&tu); err != nil || tu.Output != 5 || tu.Input != 10 || tu.CacheReadInput != 2 {
					t.Errorf("token_usage decode: err=%v got=%+v", err, tu)
				}
			}
		case <-timeout:
			t.Fatalf("timed out waiting for event %d (%s)", i, want[i])
		}
	}
}

// TestSendMessageIsFireAndForget verifies send_message does not block on a
// request-level reply (the bridge only acks via a stream event).
func TestSendMessageIsFireAndForget(t *testing.T) {
	cli, srv := net.Pipe()
	go fakeBridge(t, srv, nil)

	ctx := context.Background()
	c, err := handshake(ctx, newClient(cli), "test")
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	defer c.Close()
	if _, err := c.CreateSession(ctx, "/work"); err != nil {
		t.Fatalf("create_session: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- c.SendMessage("sess-1", "do the thing") }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("send_message: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("send_message blocked; must be fire-and-forget")
	}

	// The ack arrives as a stream event, not a reply.
	select {
	case f := <-c.Events():
		if f.Ev != "message_accepted" {
			t.Errorf("expected message_accepted, got %q", f.Ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no message_accepted event")
	}
}

// TestRequestFailsWhenConnectionCloses verifies an in-flight request returns an
// error (not a bogus zero frame) when the connection dies.
func TestRequestFailsWhenConnectionCloses(t *testing.T) {
	cli, srv := net.Pipe()
	// A bridge that answers hello, then goes away without answering the next
	// request, and closes the connection.
	go func() {
		r := bufio.NewReader(srv)
		line, _ := r.ReadBytes('\n')
		var req map[string]any
		_ = json.Unmarshal(line, &req)
		b, _ := json.Marshal(map[string]any{
			"reply_to": req["id"], "ev": "hello_ok", "version": 1, "server": "fake/1",
		})
		_, _ = srv.Write(append(b, '\n'))
		_, _ = r.ReadBytes('\n') // read create_session, never reply
		_ = srv.Close()
	}()

	ctx := context.Background()
	c, err := handshake(ctx, newClient(cli), "test")
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	if _, err := c.CreateSession(ctx, "/work"); err == nil {
		t.Fatal("expected create_session to fail when connection closed, got nil")
	}
}
