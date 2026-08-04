// Package ptyx attaches a PTY to a workspace's tmux session. The browser's
// WebSocket is glued to this PTY, so the terminal mirrors Claude Code exactly
// and survives disconnects (the tmux session keeps running underneath).
package ptyx

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// Session is a PTY attached to a tmux session via `tmux attach`.
type Session struct {
	f   *os.File
	cmd *exec.Cmd
}

// Attach opens a PTY running `tmux attach -t <name>`. Detaching (Close) leaves
// the tmux session — and Claude — running.
func Attach(name string) (*Session, error) {
	cmd := exec.Command("tmux", "attach", "-t", name)
	f, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	return &Session{f: f, cmd: cmd}, nil
}

// Read pulls terminal output (to be coalesced and sent over the WS).
func (s *Session) Read(b []byte) (int, error) { return s.f.Read(b) }

// Write forwards a keystroke from the writer client.
func (s *Session) Write(b []byte) (int, error) { return s.f.Write(b) }

// Resize propagates the client's terminal size to the PTY (and tmux client).
func (s *Session) Resize(cols, rows int) error {
	return pty.Setsize(s.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Close detaches the PTY without killing the tmux session.
func (s *Session) Close() error {
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return s.f.Close()
}
