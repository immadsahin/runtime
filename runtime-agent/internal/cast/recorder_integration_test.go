package cast

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestRecorderTmuxFidelity is the end-to-end acceptance for the recorder: it
// records a real tmux pane and asserts the scripted output is reproduced in the
// cast. Skipped where tmux is unavailable (e.g. CI without tmux), so it never
// blocks `go test`.
func TestRecorderTmuxFidelity(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}

	session := "cast-fidelity"
	// A private tmux server socket so the test never touches a user's sessions.
	socket := filepath.Join(t.TempDir(), "tmux.sock")
	ctl := func(args ...string) *exec.Cmd {
		return exec.Command("tmux", append([]string{"-S", socket}, args...)...)
	}

	if out, err := ctl("new-session", "-d", "-s", session, "sh").CombinedOutput(); err != nil {
		t.Skipf("cannot start tmux session: %v: %s", err, out)
	}
	defer ctl("kill-server").Run()

	castPath := filepath.Join(t.TempDir(), DefaultCastName)
	r := &Recorder{pane: &tmuxPaneSocket{session: session, socket: socket}, castPath: castPath}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	if out, err := ctl("send-keys", "-t", session, "printf 'CAST_OK\\n'", "Enter").CombinedOutput(); err != nil {
		t.Fatalf("send-keys: %v: %s", err, out)
	}
	time.Sleep(300 * time.Millisecond) // let the pane render + drain

	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(castPath)
	if err != nil {
		t.Fatal(err)
	}
	h, frames := parseCast(t, b)
	if h.Version != 2 {
		t.Fatalf("cast version = %d", h.Version)
	}
	var out bytes.Buffer
	for _, f := range frames {
		out.WriteString(f[2].(string))
	}
	if !bytes.Contains(out.Bytes(), []byte("CAST_OK")) {
		t.Fatalf("recorded cast missing scripted output; got %q", out.String())
	}
}

// tmuxPaneSocket is the tmux pane implementation pinned to a private server
// socket, so the integration test stays isolated from any real tmux server.
type tmuxPaneSocket struct {
	session string
	socket  string
}

func (p *tmuxPaneSocket) run(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, "tmux", append([]string{"-S", p.socket}, args...)...)
}

func (p *tmuxPaneSocket) size(ctx context.Context) (int, int, error) {
	out, err := p.run(ctx, "display-message", "-p", "-t", p.session, "#{pane_width} #{pane_height}").Output()
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) != 2 {
		return 0, 0, fmt.Errorf("unexpected pane size %q", out)
	}
	cols, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0, 0, err
	}
	rows, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, 0, err
	}
	return cols, rows, nil
}

func (p *tmuxPaneSocket) arm(ctx context.Context, fifoPath string) error {
	cmd := fmt.Sprintf("cat >> '%s'", fifoPath)
	if out, err := p.run(ctx, "pipe-pane", "-O", "-t", p.session, cmd).CombinedOutput(); err != nil {
		return fmt.Errorf("arm: %v: %s", err, out)
	}
	return nil
}

func (p *tmuxPaneSocket) disarm(ctx context.Context) error {
	if out, err := p.run(ctx, "pipe-pane", "-t", p.session).CombinedOutput(); err != nil {
		return fmt.Errorf("disarm: %v: %s", err, out)
	}
	return nil
}
