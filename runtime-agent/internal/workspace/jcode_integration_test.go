package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/jcode"
)

// TestJcodeEngineEndToEnd drives a REAL `jcode api-bridge` through the Service's
// jcode engine: Start a session, SendMessage, and assert the conversation log
// (exactly what SessionLog returns to the SSE handler) receives an assembled
// assistant record. It validates the whole box-side path — client, translator,
// consumer, demux, and the service wiring — end to end.
//
// Gated on a running bridge: set JCODE_API_SOCKET (or use the default) with
// `jcode api-bridge` up. Skipped otherwise so CI without jcode stays green.
func TestJcodeEngineEndToEnd(t *testing.T) {
	// Gated on an EXPLICIT socket path so the default `go test ./...` never runs
	// it (a stale-but-present socket would otherwise flake the suite). Run with:
	//   JCODE_API_SOCKET=/tmp/jcode-api.sock go test ./internal/workspace/ -run TestJcodeEngineEndToEnd
	socket := os.Getenv("JCODE_API_SOCKET")
	if socket == "" {
		t.Skip("set JCODE_API_SOCKET to a running `jcode api-bridge` to run this integration test")
	}
	if _, err := os.Stat(socket); err != nil {
		t.Skipf("no jcode bridge at %s", socket)
	}

	ctx := context.Background()
	client, err := jcode.Dial(ctx, socket, "workspace-itest")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	root := t.TempDir()
	const ws = "itest-ws"
	worktree := filepath.Join(root, "workspaces", ws)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}

	svc := NewService(root)
	svc.UseJcode(client)

	if _, err := svc.Start(ctx, ws, ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	if !svc.SessionAlive(ctx, ws) {
		t.Fatal("session should be alive after Start")
	}
	if err := svc.SendMessage(ws, "Reply with exactly the word: pong"); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Poll the conversation log (what the SSE handler tails) for an assistant
	// text record. A real turn returns within seconds; allow generous room.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if log := svc.SessionLog(ws); log != "" {
			data, _ := os.ReadFile(log)
			if strings.Contains(string(data), `"role":"assistant"`) &&
				strings.Contains(string(data), `"type":"text"`) {
				t.Logf("✅ conversation log (via SessionLog):\n%s", strings.TrimSpace(string(data)))
				return
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("no assistant record in conversation log within timeout; SessionLog=%q", svc.SessionLog(ws))
}
