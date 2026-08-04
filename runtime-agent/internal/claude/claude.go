// Package claude launches the real Claude Code CLI. Runtime never wraps or
// proxies Claude — it starts `claude` in the workspace's tmux session and lets
// it talk to Anthropic directly with the injected session credentials.
package claude

// Command returns the argv for launching an interactive Claude Code session.
//
// bypassPermissions makes the session autonomous (no approval prompts blocking
// "work while the laptop is closed"). This requires a non-root user — Claude
// refuses it as root (surfaced in Spike 4), which is why runtime-computer-v1
// runs as the `runtime` user.
func Command() []string {
	return []string{"claude", "--permission-mode", "bypassPermissions"}
}

// ContinueCommand resumes the most recent session in the workspace, used on
// resume after the process exited or the box restarted.
func ContinueCommand() []string {
	return []string{"claude", "--continue", "--permission-mode", "bypassPermissions"}
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
