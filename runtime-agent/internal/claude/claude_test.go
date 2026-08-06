package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readConfig(t *testing.T, home string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}
	return cfg
}

func projectEntry(t *testing.T, cfg map[string]any, worktree string) map[string]any {
	t.Helper()
	projects, ok := cfg["projects"].(map[string]any)
	if !ok {
		t.Fatalf("projects missing or wrong type: %T", cfg["projects"])
	}
	proj, ok := projects[worktree].(map[string]any)
	if !ok {
		t.Fatalf("project entry for %q missing", worktree)
	}
	return proj
}

func TestEnsureOnboardingSeedsAllGates(t *testing.T) {
	home := t.TempDir()
	worktree := "/home/runtime/workspaces/ws-1"
	if err := EnsureOnboarding(home, worktree); err != nil {
		t.Fatalf("EnsureOnboarding: %v", err)
	}
	cfg := readConfig(t, home)
	if cfg["theme"] != "dark" {
		t.Errorf("theme = %v, want dark", cfg["theme"])
	}
	if cfg["hasCompletedOnboarding"] != true {
		t.Errorf("hasCompletedOnboarding = %v, want true", cfg["hasCompletedOnboarding"])
	}
	if cfg["bypassPermissionsModeAccepted"] != true {
		t.Errorf("bypassPermissionsModeAccepted = %v, want true", cfg["bypassPermissionsModeAccepted"])
	}
	proj := projectEntry(t, cfg, worktree)
	if proj["hasTrustDialogAccepted"] != true {
		t.Errorf("hasTrustDialogAccepted = %v, want true", proj["hasTrustDialogAccepted"])
	}
	if proj["hasCompletedProjectOnboarding"] != true {
		t.Errorf("hasCompletedProjectOnboarding = %v, want true", proj["hasCompletedProjectOnboarding"])
	}
}

func TestEnsureOnboardingPreservesExistingKeys(t *testing.T) {
	home := t.TempDir()
	// Simulate an existing config Claude wrote (userID, an unrelated project).
	existing := map[string]any{
		"userID": "abc123",
		"projects": map[string]any{
			"/home/runtime/workspaces/other": map[string]any{"history": []any{"x"}},
		},
	}
	data, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	worktree := "/home/runtime/workspaces/ws-2"
	if err := EnsureOnboarding(home, worktree); err != nil {
		t.Fatalf("EnsureOnboarding: %v", err)
	}
	cfg := readConfig(t, home)

	if cfg["userID"] != "abc123" {
		t.Errorf("userID not preserved: %v", cfg["userID"])
	}
	// The unrelated project entry must survive.
	other := projectEntry(t, cfg, "/home/runtime/workspaces/other")
	if _, ok := other["history"]; !ok {
		t.Errorf("unrelated project entry was clobbered: %v", other)
	}
	// The new worktree gets trust seeded without touching the other one.
	if projectEntry(t, cfg, worktree)["hasTrustDialogAccepted"] != true {
		t.Errorf("new worktree trust not seeded")
	}
}

func TestEnsureOnboardingIdempotent(t *testing.T) {
	home := t.TempDir()
	worktree := "/home/runtime/workspaces/ws-3"
	if err := EnsureOnboarding(home, worktree); err != nil {
		t.Fatalf("first: %v", err)
	}
	first, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := EnsureOnboarding(home, worktree); err != nil {
		t.Fatalf("second: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Errorf("not idempotent:\nfirst=%s\nsecond=%s", first, second)
	}
}
