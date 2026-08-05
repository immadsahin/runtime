package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestGoldenFixtures decodes every shared fixture into its Go struct. Together
// with the zod side (test/agent-protocol.test.ts) this guarantees the TS and Go
// representations of the wire contract cannot silently drift.
func TestGoldenFixtures(t *testing.T) {
	raw, err := os.ReadFile(findFixtures(t))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var groups map[string][]json.RawMessage
	if err := json.Unmarshal(raw, &groups); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}

	for name, examples := range groups {
		for i, ex := range examples {
			if err := decodeInto(name, ex); err != nil {
				t.Errorf("%s[%d]: %v", name, i, err)
			}
		}
	}
}

func decodeInto(name string, raw json.RawMessage) error {
	switch name {
	case "RuntimeTokenClaims":
		return json.Unmarshal(raw, &RuntimeTokenClaims{})
	case "PtyClientMessage":
		return json.Unmarshal(raw, &PtyClientMessage{})
	case "PtyServerMessage":
		return json.Unmarshal(raw, &PtyServerMessage{})
	case "CreateWorkspaceRequest":
		return json.Unmarshal(raw, &CreateWorkspaceRequest{})
	case "WorkspaceActionRequest":
		return json.Unmarshal(raw, &WorkspaceActionRequest{})
	case "ErrorResponse":
		return json.Unmarshal(raw, &ErrorResponse{})
	case "SessionUrls":
		return json.Unmarshal(raw, &SessionUrls{})
	case "WorkspaceSummary":
		return json.Unmarshal(raw, &WorkspaceSummary{})
	case "ConversationMessage":
		return json.Unmarshal(raw, &ConversationMessage{})
	case "TokenUsage":
		return json.Unmarshal(raw, &TokenUsage{})
	case "WorkspaceStateChanged":
		return json.Unmarshal(raw, &WorkspaceStateChanged{})
	default:
		// A new fixture group with no Go struct is a drift we want to catch.
		return errUnknown(name)
	}
}

type unknownGroup string

func (u unknownGroup) Error() string { return "no Go struct for fixture group " + string(u) }
func errUnknown(name string) error   { return unknownGroup(name) }

// findFixtures walks up from the test's working directory to the repo root.
func findFixtures(t *testing.T) string {
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, "lib", "runtime", "agent-protocol.fixtures.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("agent-protocol.fixtures.json not found walking up from cwd")
		}
		dir = parent
	}
}
