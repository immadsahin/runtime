package cast

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// tmuxPane taps a tmux session's active pane via `tmux pipe-pane`. This is the
// production pane implementation; recorder tests use a fake.
type tmuxPane struct{ session string }

func (p *tmuxPane) size(ctx context.Context) (cols, rows int, err error) {
	out, err := exec.CommandContext(ctx, "tmux",
		"display-message", "-p", "-t", p.session, "#{pane_width} #{pane_height}",
	).Output()
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) != 2 {
		return 0, 0, fmt.Errorf("unexpected pane size output %q", out)
	}
	cols, err = strconv.Atoi(fields[0])
	if err != nil {
		return 0, 0, err
	}
	rows, err = strconv.Atoi(fields[1])
	if err != nil {
		return 0, 0, err
	}
	return cols, rows, nil
}

// arm pipes the pane's output (-O) into `cat` appending to the FIFO. tmux runs
// the shell-command via /bin/sh, so the FIFO path is single-quoted.
func (p *tmuxPane) arm(ctx context.Context, fifoPath string) error {
	cmd := fmt.Sprintf("cat >> '%s'", strings.ReplaceAll(fifoPath, "'", `'\''`))
	if out, err := exec.CommandContext(ctx, "tmux",
		"pipe-pane", "-O", "-t", p.session, cmd,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux pipe-pane arm: %v: %s", err, out)
	}
	return nil
}

// disarm closes the pane's pipe (pipe-pane with no command).
func (p *tmuxPane) disarm(ctx context.Context) error {
	if out, err := exec.CommandContext(ctx, "tmux",
		"pipe-pane", "-t", p.session,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux pipe-pane disarm: %v: %s", err, out)
	}
	return nil
}
