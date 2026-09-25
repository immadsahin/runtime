// Package claude launches the real Claude Code CLI. Runtime never wraps or
// proxies Claude — it starts `claude` in the workspace's tmux session and lets
// it talk to Anthropic directly with the injected session credentials.
package claude

import (
	"fmt"
	"strings"
)

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

// Orientation renders the Outrunner orientation system prompt injected at
// session start via --append-system-prompt. It is the floor of the prompt
// layering (Outrunner orientation → repo CLAUDE.md → owner → task): it tells
// the agent where it is running and the workspace rules. Coding style and
// project conventions deliberately belong in CLAUDE.md, not here.
//
// worktree is the absolute path of the workspace's git worktree (the agent's
// working directory). baseBranch is the branch pull requests target, e.g.
// "main". Both may be empty after a box restart that lost the recorded facts:
// an empty worktree degrades to a generic phrase, and an empty baseBranch omits
// the target-branch guidance entirely rather than naming a bogus base.
func Orientation(worktree, baseBranch string) string {
	workingDir := worktree
	if workingDir == "" {
		workingDir = "workspace"
	}
	screenshotPath := ".context/screenshot.png"
	if worktree != "" {
		screenshotPath = worktree + "/.context/screenshot.png"
	}

	var b strings.Builder
	b.WriteString("You are working inside Outrunner, a Mac app that lets the user run many coding agents in parallel.\n")
	fmt.Fprintf(&b, "Your work should take place in the %s directory (unless otherwise directed), which has been set up for you to work in.\n", workingDir)
	b.WriteString("Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.\n")
	if baseBranch != "" {
		fmt.Fprintf(&b, "The target branch for this workspace is origin/%s. Use this for actions like diffing (git diff origin/%s...) or creating PRs (gh pr create --base %s).\n", baseBranch, baseBranch, baseBranch)
	}
	b.WriteString("\nDo not rename the current branch unless the user explicitly tells you to do so.\n")
	b.WriteString("\nBy default, the user will only see the last message that you send before stopping. Include all essential information in the last message. The intermediate messages will be collapsed and accessible by the user but not displayed by default.\n")
	fmt.Fprintf(&b, "\nSave screenshots under .context/ and embed them inline in the final response using Markdown image syntax, for example ![Screenshot](<%s>).\n", screenshotPath)
	b.WriteString("\nIf the user asks you to work on several unrelated tasks, you can suggest they start new workspaces.\n")
	b.WriteString("Sometimes the user might send you a message they meant to send in a different workspace or a different chat. If something doesn't make sense in the context of your work, just ask.\n")
	b.WriteString("If the user asks for help with Outrunner, you can ask them to go to \"Help -> Send Feedback\" to get in touch with our team.")
	return b.String()
}

// SessionEnv builds the environment for a Claude session. The Anthropic
// credential is held in agent memory and injected here only — never written to
// disk on the box, never logged.
func SessionEnv(base []string, anthropicToken string) []string {
	env := append([]string{}, base...)
	// Suppress Claude's startup network work (auto-update, marketplace install,
	// non-essential telemetry). On a fresh box that work takes several seconds,
	// during which the TUI silently drops any prompt submitted into it — the
	// cause of "I typed but Claude never answered" right after a workspace opens.
	// It also removes the "Auto-update failed" / "marketplace" noise from the
	// pane. The essential model API traffic is unaffected.
	env = append(env,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_AUTOUPDATER=1",
	)
	if anthropicToken != "" {
		env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+anthropicToken)
	}
	return env
}
