package claude

import (
	"slices"
	"strings"
	"testing"
)

func TestOrientationRendersWorkingDirAndBase(t *testing.T) {
	got := Orientation("/work/ws1", "main")

	for _, want := range []string{
		"You are working inside Outrunner, a Mac app that lets the user run many coding agents in parallel.",
		"Your work should take place in the /work/ws1 directory (unless otherwise directed), which has been set up for you to work in.",
		// Both git-command spots must interpolate the base branch.
		"The target branch for this workspace is origin/main. Use this for actions like diffing (git diff origin/main...) or creating PRs (gh pr create --base main).",
		// The screenshot example embeds the worktree path.
		"![Screenshot](</work/ws1/.context/screenshot.png>)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("orientation missing %q:\n%s", want, got)
		}
	}
}

// The four workspace lines that reference Outrunner product behavior must always
// render verbatim, independent of the templated branch/path values.
func TestOrientationIncludesVerbatimLines(t *testing.T) {
	got := Orientation("/work/ws1", "main")

	for _, want := range []string{
		"Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.",
		"Do not rename the current branch unless the user explicitly tells you to do so.",
		"By default, the user will only see the last message that you send before stopping.",
		"The intermediate messages will be collapsed and accessible by the user but not displayed by default.",
		"If the user asks you to work on several unrelated tasks, you can suggest they start new workspaces.",
		"Sometimes the user might send you a message they meant to send in a different workspace or a different chat.",
		`If the user asks for help with Outrunner, you can ask them to go to "Help -> Send Feedback" to get in touch with our team.`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("orientation missing verbatim line %q:\n%s", want, got)
		}
	}
	// The source is Conductor's block; nothing should still say "Conductor".
	if strings.Contains(got, "Conductor") {
		t.Errorf("orientation still mentions Conductor:\n%s", got)
	}
}

func TestOrientationOmitsBaseWhenUnknown(t *testing.T) {
	got := Orientation("/work/ws1", "")

	// Base is unknown (e.g. after a box restart): the target-branch guidance is
	// dropped entirely rather than naming a bogus base.
	for _, unwanted := range []string{
		"target branch for this workspace",
		"gh pr create --base",
		"git diff origin/",
	} {
		if strings.Contains(got, unwanted) {
			t.Errorf("expected no base guidance, but found %q:\n%s", unwanted, got)
		}
	}
	// The rest of the prompt still stands on its own.
	if !strings.Contains(got, "Your work should take place in the /work/ws1 directory") {
		t.Errorf("working-dir line dropped when base is unknown:\n%s", got)
	}
	if !strings.Contains(got, "Do not rename the current branch") {
		t.Errorf("workspace rules dropped when base is unknown:\n%s", got)
	}
}

func TestOrientationDegradesWhenWorktreeMissing(t *testing.T) {
	got := Orientation("", "main")

	// An empty worktree (defensive: the call site always supplies one) falls back
	// to a generic phrase and a relative screenshot path — never a bare or broken
	// absolute path.
	if !strings.Contains(got, "Your work should take place in the workspace directory (unless otherwise directed)") {
		t.Errorf("worktree fallback phrase missing:\n%s", got)
	}
	if !strings.Contains(got, "![Screenshot](<.context/screenshot.png>)") {
		t.Errorf("screenshot example should use a relative path when worktree is empty:\n%s", got)
	}
	if strings.Contains(got, "<//.context") || strings.Contains(got, "in the  directory") {
		t.Errorf("empty worktree leaked a malformed path:\n%s", got)
	}
	// The base branch is still known, so its guidance renders.
	if !strings.Contains(got, "target branch for this workspace is origin/main") {
		t.Errorf("base guidance dropped when only worktree is missing:\n%s", got)
	}
}

func TestCommandInjectsOrientation(t *testing.T) {
	orientation := Orientation("/work/ws1", "main")

	for _, tc := range []struct {
		name string
		argv []string
		head []string
	}{
		{"Command", Command(orientation), []string{"claude", "--permission-mode", "bypassPermissions"}},
		{"ContinueCommand", ContinueCommand(orientation), []string{"claude", "--continue", "--permission-mode", "bypassPermissions"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if !slices.Equal(tc.argv[:len(tc.head)], tc.head) {
				t.Errorf("unexpected base argv: %v", tc.argv)
			}
			i := slices.Index(tc.argv, "--append-system-prompt")
			if i < 0 {
				t.Fatalf("argv missing --append-system-prompt: %v", tc.argv)
			}
			if i != len(tc.argv)-2 || tc.argv[i+1] != orientation {
				t.Errorf("orientation not passed as the flag value: %v", tc.argv)
			}
		})
	}
}

func TestCommandOmitsFlagWhenNoOrientation(t *testing.T) {
	if slices.Contains(Command(""), "--append-system-prompt") {
		t.Errorf("empty orientation must not add the flag: %v", Command(""))
	}
	if slices.Contains(ContinueCommand(""), "--append-system-prompt") {
		t.Errorf("empty orientation must not add the flag: %v", ContinueCommand(""))
	}
}

func TestSessionEnvInjectsStartupFlagsAndToken(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/home/daytona"}
	env := SessionEnv(base, "tok-123")

	// Base entries are preserved and come first.
	if env[0] != "PATH=/usr/bin" || env[1] != "HOME=/home/daytona" {
		t.Fatalf("base entries not preserved at the front: %v", env[:2])
	}
	// Both startup-suppression flags are always present.
	for _, want := range []string{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1"} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %q in SessionEnv output: %v", want, env)
		}
	}
	// The credential is appended last when non-empty.
	if last := env[len(env)-1]; last != "CLAUDE_CODE_OAUTH_TOKEN=tok-123" {
		t.Errorf("token not appended last, got %q", last)
	}
}

func TestSessionEnvOmitsTokenWhenEmpty(t *testing.T) {
	env := SessionEnv(nil, "")
	for _, e := range env {
		if strings.HasPrefix(e, "CLAUDE_CODE_OAUTH_TOKEN=") {
			t.Fatalf("token should be omitted when empty, got %q", e)
		}
	}
	// The flags are still injected.
	if !slices.Contains(env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1") {
		t.Errorf("startup flag missing when token empty: %v", env)
	}
}
