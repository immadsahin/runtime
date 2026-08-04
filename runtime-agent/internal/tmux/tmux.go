// Package tmux manages the tmux sessions that keep Claude alive across browser
// disconnects. One tmux session per workspace; the server is independent of the
// agent process, so sessions survive an agent restart (validated in Spike 2).
package tmux

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Manager runs tmux commands via the local binary.
type Manager struct{}

func New() *Manager { return &Manager{} }

// NewSession starts a detached session named `name` running `command` in
// `workdir`, with the given extra environment. Returns an error if it already
// exists or tmux fails.
func (m *Manager) NewSession(ctx context.Context, name, workdir string, command []string, env []string) error {
	args := []string{"new-session", "-d", "-s", name, "-c", workdir}
	args = append(args, command...)
	cmd := exec.CommandContext(ctx, "tmux", args...)
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session %s: %v: %s", name, err, out)
	}
	return nil
}

// HasSession reports whether a session with the given name exists.
func (m *Manager) HasSession(ctx context.Context, name string) bool {
	return exec.CommandContext(ctx, "tmux", "has-session", "-t", name).Run() == nil
}

// KillSession terminates a session (and the process inside it). A missing
// session is not an error.
func (m *Manager) KillSession(ctx context.Context, name string) error {
	if !m.HasSession(ctx, name) {
		return nil
	}
	if out, err := exec.CommandContext(ctx, "tmux", "kill-session", "-t", name).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux kill-session %s: %v: %s", name, err, out)
	}
	return nil
}

// ListSessions returns the names of all live sessions.
func (m *Manager) ListSessions(ctx context.Context) ([]string, error) {
	out, err := exec.CommandContext(ctx, "tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		// tmux exits non-zero when there is no server/sessions; treat as empty.
		return nil, nil
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}
