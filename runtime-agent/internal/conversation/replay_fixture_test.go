package conversation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestReplayFixtureParity pins the Go `decode` to the SAME golden fixture the TS
// replay parser (lib/runtime/replay/conversation.ts) asserts against. Replay
// runs off-box in TypeScript with no agent, so the two parsers must produce
// byte-identical AgentEvents for the same JSONL — this fixture is the contract
// that stops them drifting.
func TestReplayFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(findReplayFixtures(t))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var fixture struct {
		Lines  []string          `json:"lines"`
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}

	var got []map[string]any
	for _, line := range fixture.Lines {
		ev, ok := decode([]byte(line))
		if !ok {
			continue
		}
		encoded, err := json.Marshal(ev.Message)
		if err != nil {
			t.Fatalf("marshal event: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(encoded, &m); err != nil {
			t.Fatalf("re-decode event: %v", err)
		}
		got = append(got, m)
	}

	if len(got) != len(fixture.Events) {
		t.Fatalf("event count: got %d, want %d", len(got), len(fixture.Events))
	}
	for i, want := range fixture.Events {
		var wantMap map[string]any
		if err := json.Unmarshal(want, &wantMap); err != nil {
			t.Fatalf("decode expected[%d]: %v", i, err)
		}
		if !reflect.DeepEqual(got[i], wantMap) {
			t.Fatalf("event[%d] mismatch:\n got  %v\n want %v", i, got[i], wantMap)
		}
	}
}

// findReplayFixtures walks up from the test's working directory to the repo root.
func findReplayFixtures(t *testing.T) string {
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, "lib", "runtime", "replay", "conversation.fixtures.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("conversation.fixtures.json not found walking up from cwd")
		}
		dir = parent
	}
}
