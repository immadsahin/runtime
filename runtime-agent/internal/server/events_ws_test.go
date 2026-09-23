package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsURL turns the fixture's http:// test URL into a ws:// /events-ws URL.
func (f *serverFixture) wsURL(t *testing.T, lastEventID string) string {
	t.Helper()
	base := "ws" + strings.TrimPrefix(f.url, "http")
	url := fmt.Sprintf("%s/events-ws?token=%s", base, f.token(t))
	if lastEventID != "" {
		url += "&lastEventId=" + lastEventID
	}
	return url
}

// readWSFrame reads one JSON event frame ({id,data}) within deadline, returning
// it as an sseFrame so the shared assertions (assertMessageWithText) apply.
func readWSFrame(t *testing.T, conn *websocket.Conn, deadline time.Duration) sseFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(deadline))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read ws frame: %v", err)
	}
	var frame struct {
		ID   string          `json:"id"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal ws frame %q: %v", data, err)
	}
	return sseFrame{ID: frame.ID, Data: string(frame.Data)}
}

func TestEventsWSRejectsBadToken(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	base := "ws" + strings.TrimPrefix(f.url, "http")
	_, resp, err := websocket.DefaultDialer.Dial(base+"/events-ws?token=nope", nil)
	if err == nil {
		t.Fatal("expected handshake to fail with a bad token")
	}
	if resp == nil || resp.StatusCode != 401 {
		t.Fatalf("expected 401 on bad token, got %v", resp)
	}
}

func TestEventsWSEmitsStateThenMessage(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	conn, _, err := websocket.DefaultDialer.Dial(f.wsURL(t, ""), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// First frame is the synthetic, non-resumable state event (id 0).
	state := readWSFrame(t, conn, 2*time.Second)
	if state.ID != "0" {
		t.Fatalf("state frame ID should be 0, got %q", state.ID)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(state.Data), &payload); err != nil {
		t.Fatalf("parse state: %v", err)
	}
	if payload["t"] != "state" || payload["workspaceId"] != f.workspaceID {
		t.Fatalf("wrong state frame: %+v", payload)
	}

	// A live append must arrive over the open socket (no reconnect needed) — the
	// whole point of moving off SSE.
	f.appendJSONL(t, msg1)
	msg := readWSFrame(t, conn, 2*time.Second)
	assertMessageWithText(t, msg, "first")
	if msg.ID == "0" || msg.ID == "" {
		t.Fatalf("message frame must carry a resumable id, got %q", msg.ID)
	}
}

func TestEventsWSResumeIsGapFreeAndDupeFree(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	f.appendJSONL(t, msg1)

	// Connect 1: read state + msg1, remember msg1's id, then disconnect.
	conn1, _, err := websocket.DefaultDialer.Dial(f.wsURL(t, ""), nil)
	if err != nil {
		t.Fatalf("dial 1: %v", err)
	}
	_ = readWSFrame(t, conn1, 2*time.Second) // state
	first := readWSFrame(t, conn1, 2*time.Second)
	assertMessageWithText(t, first, "first")
	lastID := first.ID
	conn1.Close()

	// While disconnected, append msg2 and msg3.
	f.appendJSONL(t, msg2, msg3)

	// Connect 2 with lastEventId: must deliver ONLY msg2, msg3 — no state
	// re-emit, no msg1 dupe.
	conn2, _, err := websocket.DefaultDialer.Dial(f.wsURL(t, lastID), nil)
	if err != nil {
		t.Fatalf("dial 2: %v", err)
	}
	defer conn2.Close()
	assertMessageWithText(t, readWSFrame(t, conn2, 2*time.Second), "second")
	assertMessageWithText(t, readWSFrame(t, conn2, 2*time.Second), "third")
}
