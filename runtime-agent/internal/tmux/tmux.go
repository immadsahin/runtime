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

// SendKeys delivers `text` as one prompt to the session's active pane and
// submits it with a single Enter — how the composer drives Claude on the
// default engine (jcode uses its own message API instead).
//
// The text is pasted through a tmux buffer with bracketed paste (paste-buffer
// -p) rather than typed with `send-keys -l`. A literal send-keys turns every
// embedded newline into a submit, so a multi-line prompt would fire its first
// line early and scatter the rest across later prompts. Bracketed paste makes
// Claude insert those newlines as input; the one trailing Enter then submits
// the whole thing. Loading via stdin (`load-buffer -`) also sidesteps
// arg-length and quoting limits and keeps the exact bytes intact.
//
// Callers must serialize SendKeys per session: the load/paste/Enter steps are
// separate tmux commands, so concurrent calls on one pane could interleave
// (Service.SendMessage holds a per-workspace lock for this reason).
func (m *Manager) SendKeys(ctx context.Context, name, text string) error {
	if !m.HasSession(ctx, name) {
		return fmt.Errorf("tmux send-keys: no session %s", name)
	}
	buf := "runtime-send-" + name
	load := exec.CommandContext(ctx, "tmux", "load-buffer", "-b", buf, "-")
	load.Stdin = strings.NewReader(text)
	if out, err := load.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux load-buffer %s: %v: %s", name, err, out)
	}
	// -p: bracketed paste (newlines land as input, not submits). -d: delete the
	// buffer afterward so buffers don't accumulate across sends.
	if out, err := exec.CommandContext(ctx, "tmux", "paste-buffer", "-t", name, "-b", buf, "-d", "-p").CombinedOutput(); err != nil {
		return fmt.Errorf("tmux paste-buffer %s: %v: %s", name, err, out)
	}
	if out, err := exec.CommandContext(ctx, "tmux", "send-keys", "-t", name, "Enter").CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys Enter %s: %v: %s", name, err, out)
	}
	return nil
}

// CapturePane returns the current visible contents of the session's active
// pane. Used to detect when Claude's TUI has finished mounting and is ready to
// accept a submitted prompt.
func (m *Manager) CapturePane(ctx context.Context, name string) (string, error) {
	out, err := exec.CommandContext(ctx, "tmux", "capture-pane", "-t", name, "-p").Output()
	if err != nil {
		return "", fmt.Errorf("tmux capture-pane %s: %w", name, err)
	}
	return string(out), nil
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
