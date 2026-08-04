// Command runtime-agent is the data-plane daemon that runs on each Runtime
// Computer. It owns git worktrees, tmux sessions, the Claude processes, PTY
// streaming, and the conversation watcher. The Next control plane talks to it
// over HTTP; the browser connects directly to WS /pty.
package main

import (
	"log"
	"net/http"
	"os"

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

	srv := server.New(secret, workspace.NewService(root))
	log.Printf("runtime-agent listening on :%s (root=%s)", port, root)
	if err := http.ListenAndServe(":"+port, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
