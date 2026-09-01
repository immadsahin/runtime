// Command runtime-agent is the data-plane daemon that runs on each Runtime
// Computer. It owns git worktrees, tmux sessions, the Claude processes, PTY
// streaming, and the conversation watcher. The Next control plane talks to it
// over HTTP; the browser connects directly to WS /pty.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"runtime-agent/internal/jcode"
	"runtime-agent/internal/server"
	"runtime-agent/internal/workspace"
)

func main() {
	secret := os.Getenv("RUNTIME_AGENT_SECRET")
	if secret == "" {
		log.Fatal("RUNTIME_AGENT_SECRET is required")
	}
	root := envOr("RUNTIME_AGENT_ROOT", "/home/runtime")
	port := envOr("PORT", "8080")

	svc := workspace.NewService(root)

	// RUNTIME_ENGINE=jcode drives workspaces through a jcode api-bridge instead
	// of Claude-in-tmux. The bridge is expected to be running on the box; we
	// connect to its Unix socket.
	if os.Getenv("RUNTIME_ENGINE") == "jcode" {
		socket := envOr("JCODE_API_SOCKET", defaultJcodeSocket())
		client, err := jcode.Dial(context.Background(), socket, "runtime-agent")
		if err != nil {
			log.Fatalf("jcode engine: dial %s: %v", socket, err)
		}
		svc.UseJcode(client)
		log.Printf("runtime-agent: jcode engine (server=%s via %s)", client.Server(), socket)
	}

	srv := server.New(secret, svc)
	log.Printf("runtime-agent listening on :%s (root=%s)", port, root)
	if err := http.ListenAndServe(":"+port, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}

// defaultJcodeSocket mirrors the bridge's default ($XDG_RUNTIME_DIR/jcode-api.sock),
// falling back to /tmp when the runtime dir is unset (e.g. a bare container).
func defaultJcodeSocket() string {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = "/tmp"
	}
	return filepath.Join(dir, "jcode-api.sock")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
