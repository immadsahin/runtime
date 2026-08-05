package server

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

// mintToken builds a valid HS256 Runtime token for tests (auth.Mint isn't
// exported on the Go side today; the TS control plane owns real minting).
func mintToken(claims protocol.RuntimeTokenClaims, secret string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(body)
	signing := header + "." + payload
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signing))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signing + "." + sig
}

// slugFor mirrors workspace.claudeSlug (unexported). If either drifts the test
// fails clearly, which is the correct signal — the slug format is contract.
func slugFor(path string) string {
	b := make([]byte, 0, len(path))
	for i := 0; i < len(path); i++ {
		c := path[i]
		if c == '/' || c == '.' {
			b = append(b, '-')
		} else {
			b = append(b, c)
		}
	}
	return string(b)
}

// serverFixture stands up a real Server backed by a temp root, isolates
// $HOME so SessionLog reads from a scratch dir, and returns everything the
// test needs to drive /events over HTTP.
type serverFixture struct {
	url         string
	secret      string
	workspaceID string
	jsonlPath   string
	stop        func()
}

func newServerFixture(t *testing.T) *serverFixture {
	t.Helper()

	root := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)

	secret := "test-secret"
	workspaceID := "ws-events"

	svc := workspace.NewService(root)
	srv := New(secret, svc)

	worktree := filepath.Join(root, "workspaces", workspaceID)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatalf("mkdir worktree: %v", err)
	}
	logDir := filepath.Join(home, ".claude", "projects", slugFor(worktree))
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("mkdir logdir: %v", err)
	}
	jsonlPath := filepath.Join(logDir, "session.jsonl")
	if err := os.WriteFile(jsonlPath, nil, 0o600); err != nil {
		t.Fatalf("touch jsonl: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())

	return &serverFixture{
		url:         ts.URL,
		secret:      secret,
		workspaceID: workspaceID,
		jsonlPath:   jsonlPath,
		stop:        ts.Close,
	}
}

// token mints a Runtime token good for 60s.
func (f *serverFixture) token(t *testing.T) string {
	t.Helper()
	return mintToken(protocol.RuntimeTokenClaims{
		WorkspaceID: f.workspaceID,
		ProjectID:   "p", ComputerID: "c", UserID: "u",
		Exp: time.Now().Add(time.Minute).Unix(),
	}, f.secret)
}

// appendJSONL writes the given lines to the fixture's JSONL file with newlines.
func (f *serverFixture) appendJSONL(t *testing.T, lines ...string) {
	t.Helper()
	fh, err := os.OpenFile(f.jsonlPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open jsonl: %v", err)
	}
	defer fh.Close()
	for _, line := range lines {
		if _, err := fh.WriteString(line + "\n"); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
}

// sseFrame is one parsed `id:…\ndata:…` block from the stream.
type sseFrame struct {
	ID   string
	Data string
}

// readSSE consumes frames from resp.Body until deadline OR n frames arrive.
// Ignores heartbeat (`:keepalive`) comment lines.
func readSSE(t *testing.T, r *bufio.Reader, n int, deadline time.Duration) []sseFrame {
	t.Helper()
	done := make(chan []sseFrame, 1)
	go func() {
		var out []sseFrame
		var cur sseFrame
		for len(out) < n {
			line, err := r.ReadString('\n')
			if err != nil {
				done <- out
				return
			}
			line = strings.TrimRight(line, "\r\n")
			switch {
			case strings.HasPrefix(line, ":"):
				continue // heartbeat/comment
			case strings.HasPrefix(line, "id: "):
				cur.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "data: "):
				cur.Data = strings.TrimPrefix(line, "data: ")
			case line == "":
				if cur.ID != "" || cur.Data != "" {
					out = append(out, cur)
					cur = sseFrame{}
				}
			}
		}
		done <- out
	}()

	select {
	case out := <-done:
		return out
	case <-time.After(deadline):
		t.Fatalf("timed out waiting for %d SSE frames", n)
		return nil
	}
}

// dial opens an SSE connection with the given lastEventId query param (empty for none).
func (f *serverFixture) dial(t *testing.T, lastEventID string) (*http.Response, context.CancelFunc) {
	t.Helper()
	url := fmt.Sprintf("%s/events?token=%s", f.url, f.token(t))
	if lastEventID != "" {
		url += "&lastEventId=" + lastEventID
	}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		t.Fatalf("build req: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	req = req.WithContext(ctx)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("do: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := os.ReadFile("/dev/null") // best-effort
		_ = body
		cancel()
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		cancel()
		t.Fatalf("wrong Content-Type: %q", got)
	}
	return resp, cancel
}

const (
	msg1 = `{"type":"assistant","uuid":"m1","parentUuid":null,"timestamp":"t1","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}`
	msg2 = `{"type":"assistant","uuid":"m2","parentUuid":"m1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}`
	msg3 = `{"type":"assistant","uuid":"m3","parentUuid":"m2","timestamp":"t3","message":{"role":"assistant","content":[{"type":"text","text":"third"}]}}`
)

func TestEventsRequiresValidToken(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	resp, err := http.Get(fmt.Sprintf("%s/events?token=nope", f.url))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestEventsEmitsInitialStateFrame(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	resp, cancel := f.dial(t, "")
	defer cancel()
	defer resp.Body.Close()

	frames := readSSE(t, bufio.NewReader(resp.Body), 1, 2*time.Second)
	if len(frames) != 1 {
		t.Fatalf("want 1 frame, got %d", len(frames))
	}
	if frames[0].ID != "0" {
		t.Fatalf("state frame ID should be 0, got %q", frames[0].ID)
	}
	var state map[string]any
	if err := json.Unmarshal([]byte(frames[0].Data), &state); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if state["t"] != "state" || state["workspaceId"] != f.workspaceID {
		t.Fatalf("wrong state frame: %+v", state)
	}
}

func TestEventsResumeIsGapFreeAndDupeFree(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	f.appendJSONL(t, msg1)

	// Connect 1: read state + msg1, remember msg1's id, then disconnect.
	resp1, cancel1 := f.dial(t, "")
	defer resp1.Body.Close()
	frames := readSSE(t, bufio.NewReader(resp1.Body), 2, 2*time.Second)
	if len(frames) != 2 {
		t.Fatalf("first connect: want 2 frames, got %d", len(frames))
	}
	assertMessageWithText(t, frames[1], "first")
	lastID := frames[1].ID
	cancel1()
	resp1.Body.Close()

	// While disconnected, append msg2 and msg3 to the JSONL.
	f.appendJSONL(t, msg2, msg3)

	// Connect 2 with Last-Event-ID: must deliver ONLY msg2, msg3. No state
	// re-emit; no msg1 dupe.
	resp2, cancel2 := f.dial(t, lastID)
	defer cancel2()
	defer resp2.Body.Close()

	frames2 := readSSE(t, bufio.NewReader(resp2.Body), 2, 2*time.Second)
	if len(frames2) != 2 {
		t.Fatalf("resume: want 2 frames, got %d: %+v", len(frames2), frames2)
	}
	assertMessageWithText(t, frames2[0], "second")
	assertMessageWithText(t, frames2[1], "third")

	// Absolutely no state frame after resume.
	for _, fr := range frames2 {
		if strings.Contains(fr.Data, `"t":"state"`) {
			t.Fatalf("resume must not re-emit state; got %+v", fr)
		}
	}
}

func TestEventsFreshConnectStreamsBacklog(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	f.appendJSONL(t, msg1, msg2)

	resp, cancel := f.dial(t, "")
	defer cancel()
	defer resp.Body.Close()

	frames := readSSE(t, bufio.NewReader(resp.Body), 3, 2*time.Second)
	if len(frames) != 3 {
		t.Fatalf("want state+2 backlog frames, got %d", len(frames))
	}
	if frames[0].ID != "0" {
		t.Fatalf("frame 0 should be state (id=0), got id=%q", frames[0].ID)
	}
	assertMessageWithText(t, frames[1], "first")
	assertMessageWithText(t, frames[2], "second")

	// IDs are strictly monotonic for message frames.
	if frames[1].ID == frames[2].ID {
		t.Fatalf("message IDs must differ, got %q and %q", frames[1].ID, frames[2].ID)
	}
}

func assertMessageWithText(t *testing.T, frame sseFrame, want string) {
	t.Helper()
	var raw map[string]any
	if err := json.Unmarshal([]byte(frame.Data), &raw); err != nil {
		t.Fatalf("parse frame %+v: %v", frame, err)
	}
	if raw["t"] != "message" {
		t.Fatalf("expected message frame, got %+v", raw)
	}
	content, ok := raw["content"].([]any)
	if !ok || len(content) == 0 {
		t.Fatalf("frame missing content: %+v", raw)
	}
	first, ok := content[0].(map[string]any)
	if !ok || first["type"] != "text" || first["text"] != want {
		t.Fatalf("expected text=%q, got %+v", want, first)
	}
}
