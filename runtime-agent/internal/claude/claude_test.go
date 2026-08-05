package claude

import (
	"slices"
	"strings"
	"testing"
)

func TestOrientationRendersBranchAndBase(t *testing.T) {
	got := Orientation("feature/login", "main")

	if !strings.Contains(got, "on branch `feature/login`, based on `main`, inside a persistent cloud computer.") {
		t.Errorf("location sentence missing branch/base:\n%s", got)
	}
	// The four workspace rules must always be present.
	for _, want := range []string{
		"Your session persists.",
		"published as a pull request",
		"Other workspaces are isolated",
		"Follow this repository's CLAUDE.md",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("orientation missing rule %q:\n%s", want, got)
		}
	}
}

func TestOrientationDegradesWhenFactsMissing(t *testing.T) {
	tests := []struct {
		name            string
		branch, base    string
		wantLocation    string
		wantNotContains string
	}{
		{
			name:            "branch only omits base clause",
			branch:          "feature/login",
			wantLocation:    "an isolated git worktree on branch `feature/login`, inside a persistent cloud computer.",
			wantNotContains: "based on",
		},
		{
			name:            "no facts falls back to bare worktree",
			wantLocation:    "an isolated git worktree inside a persistent cloud computer.",
			wantNotContains: "on branch",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Orientation(tt.branch, tt.base)
			if !strings.Contains(got, tt.wantLocation) {
				t.Errorf("want location %q in:\n%s", tt.wantLocation, got)
			}
			if strings.Contains(got, tt.wantNotContains) {
				t.Errorf("did not expect %q in:\n%s", tt.wantNotContains, got)
			}
			// Rules are branch-independent and must survive degradation.
			if !strings.Contains(got, "Follow this repository's CLAUDE.md") {
				t.Errorf("rules dropped on degraded prompt:\n%s", got)
			}
		})
	}
}

func TestCommandInjectsOrientation(t *testing.T) {
	orientation := Orientation("feature/login", "main")

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
