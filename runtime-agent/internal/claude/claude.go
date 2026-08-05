// Package claude launches the real Claude Code CLI. Runtime never wraps or
// proxies Claude — it starts `claude` in the workspace's tmux session and lets
// it talk to Anthropic directly with the injected session credentials.
package claude

import "fmt"

// Command returns the argv for launching an interactive Claude Code session.
//
// bypassPermissions makes the session autonomous (no approval prompts blocking
// "work while the laptop is closed"). This requires a non-root user — Claude
// refuses it as root (surfaced in Spike 4), which is why runtime-computer-v1
// runs as the `runtime` user.
//
// orientation, when non-empty, is injected via --append-system-prompt so Claude
// knows it's running inside a Runtime Workspace (see Orientation).
func Command(orientation string) []string {
	return withOrientation([]string{"claude", "--permission-mode", "bypassPermissions"}, orientation)
}

// ContinueCommand resumes the most recent session in the workspace, used on
// resume after the process exited or the box restarted.
func ContinueCommand(orientation string) []string {
	return withOrientation([]string{"claude", "--continue", "--permission-mode", "bypassPermissions"}, orientation)
}

// withOrientation appends --append-system-prompt when there's an orientation to
// inject. We *append* rather than replace so Claude's built-in defaults and the
// repo's auto-loaded CLAUDE.md still apply — the orientation is the floor of the
// prompt stack, not a ceiling.
func withOrientation(argv []string, orientation string) []string {
	if orientation == "" {
		return argv
	}
	return append(argv, "--append-system-prompt", orientation)
}

// Orientation renders the Runtime orientation system prompt injected at session
// start. It is the floor of the prompt layering
// (Runtime orientation → repo CLAUDE.md → owner → task): only *where* the
// session runs plus the workspace rules. Coding style and project conventions
// deliberately belong in CLAUDE.md, not here.
//
// It is pure and always renders the four rules; the location sentence adapts to
// whichever of branch/baseBranch are known. Both may be empty after a box
// restart that lost the in-memory facts — the rules still stand on their own.
func Orientation(branch, baseBranch string) string {
	var location string
	switch {
	case branch != "" && baseBranch != "":
		location = fmt.Sprintf("an isolated git worktree on branch `%s`, based on `%s`,", branch, baseBranch)
	case branch != "":
		location = fmt.Sprintf("an isolated git worktree on branch `%s`,", branch)
	default:
		location = "an isolated git worktree"
	}
	return fmt.Sprintf(`You are running inside a Runtime Workspace: %s inside a persistent cloud computer.

- Your session persists. The user may disconnect and reconnect; keep working.
- Your changes stay on this branch and are published as a pull request. Do not switch branches or push to the base branch.
- Other workspaces are isolated from yours.
- Follow this repository's CLAUDE.md and conventions.`, location)
}

// SessionEnv builds the environment for a Claude session. The Anthropic
// credential is held in agent memory and injected here only — never written to
// disk on the box, never logged.
func SessionEnv(base []string, anthropicToken string) []string {
	env := append([]string{}, base...)
	if anthropicToken != "" {
		env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+anthropicToken)
	}
	return env
}
