package jcode

import (
	"encoding/json"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
)

// evt builds a stream Frame with its payload marshalled into raw, matching what
// the client's read loop produces.
func evt(ev, sessionID string, payload map[string]any) Frame {
	m := map[string]any{"ev": ev, "session_id": sessionID}
	for k, v := range payload {
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	return Frame{Ev: ev, SessionID: sessionID, raw: raw}
}

// decoded is the shape conversation.Watcher parses a record into; the test
// asserts against it to prove the produced line round-trips.
type decoded struct {
	Type    string `json:"type"`
	UUID    string `json:"uuid"`
	Message struct {
		Role    string                  `json:"role"`
		Content []protocol.ContentBlock `json:"content"`
	} `json:"message"`
}

func TestConversationAssemblesTurn(t *testing.T) {
	fixed := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	c := NewConversation("sess", func() time.Time { return fixed })

	seq := []Frame{
		evt(EvTextDelta, "sess", map[string]any{"text": "Let me "}),
		evt(EvTextDelta, "sess", map[string]any{"text": "check."}),
		evt(EvToolStart, "sess", map[string]any{"call_id": "c1", "name": "Bash"}),
		evt(EvToolInputDelta, "sess", map[string]any{"call_id": "c1", "delta": `{"command":`}),
		evt(EvToolInputDelta, "sess", map[string]any{"call_id": "c1", "delta": `"ls"}`}),
		evt(EvToolDone, "sess", map[string]any{"call_id": "c1", "name": "Bash", "output": "file.txt"}),
		evt(EvTextDelta, "sess", map[string]any{"text": "Done."}),
	}
	var complete bool
	for _, f := range seq {
		complete = c.Apply(f)
	}
	if complete {
		t.Fatal("turn should not be complete before turn_done")
	}
	if complete = c.Apply(evt(EvTurnDone, "sess", nil)); !complete {
		t.Fatal("turn_done should complete the turn")
	}

	var rec decoded
	if err := json.Unmarshal(c.Record(), &rec); err != nil {
		t.Fatalf("record does not decode: %v", err)
	}
	if rec.Type != "assistant" || rec.UUID != "sess-0" || rec.Message.Role != "assistant" {
		t.Fatalf("record header wrong: %+v", rec)
	}

	blocks := rec.Message.Content
	if len(blocks) != 4 {
		t.Fatalf("want 4 content blocks, got %d: %+v", len(blocks), blocks)
	}
	// Block 0: merged leading text.
	if blocks[0].Type != "text" || blocks[0].Text != "Let me check." {
		t.Errorf("block0 = %+v", blocks[0])
	}
	// Block 1: tool_use with reassembled JSON input.
	if blocks[1].Type != "tool_use" || blocks[1].ID != "c1" || blocks[1].Name != "Bash" {
		t.Errorf("block1 = %+v", blocks[1])
	}
	var input map[string]string
	if err := json.Unmarshal(blocks[1].Input, &input); err != nil || input["command"] != "ls" {
		t.Errorf("tool input = %s (err %v)", blocks[1].Input, err)
	}
	// Block 2: tool_result carrying the output as a JSON string.
	if blocks[2].Type != "tool_result" || blocks[2].ToolUseID != "c1" {
		t.Errorf("block2 = %+v", blocks[2])
	}
	var out string
	if err := json.Unmarshal(blocks[2].Content, &out); err != nil || out != "file.txt" {
		t.Errorf("tool_result content = %s (err %v)", blocks[2].Content, err)
	}
	// Block 3: trailing text after the tool starts a NEW text block.
	if blocks[3].Type != "text" || blocks[3].Text != "Done." {
		t.Errorf("block3 = %+v", blocks[3])
	}
}

func TestConversationStreamingUpsertsSameUUID(t *testing.T) {
	c := NewConversation("s", func() time.Time { return time.Unix(0, 0).UTC() })

	c.Apply(evt(EvTextDelta, "s", map[string]any{"text": "par"}))
	var first decoded
	if err := json.Unmarshal(c.Record(), &first); err != nil {
		t.Fatalf("first record: %v", err)
	}
	if first.Message.Content[0].Text != "par" {
		t.Errorf("partial text = %q", first.Message.Content[0].Text)
	}

	c.Apply(evt(EvTextDelta, "s", map[string]any{"text": "tial"}))
	var second decoded
	if err := json.Unmarshal(c.Record(), &second); err != nil {
		t.Fatalf("second record: %v", err)
	}
	// Same uuid (so the UI upserts), grown text.
	if second.UUID != first.UUID {
		t.Errorf("uuid changed mid-turn: %q -> %q", first.UUID, second.UUID)
	}
	if second.Message.Content[0].Text != "partial" {
		t.Errorf("grown text = %q", second.Message.Content[0].Text)
	}
}

func TestConversationResetStartsNewTurn(t *testing.T) {
	c := NewConversation("s", func() time.Time { return time.Unix(0, 0).UTC() })
	c.Apply(evt(EvTextDelta, "s", map[string]any{"text": "one"}))
	c.Apply(evt(EvTurnDone, "s", nil))
	c.Reset()
	c.Apply(evt(EvTextDelta, "s", map[string]any{"text": "two"}))

	var rec decoded
	if err := json.Unmarshal(c.Record(), &rec); err != nil {
		t.Fatalf("record: %v", err)
	}
	if rec.UUID != "s-1" {
		t.Errorf("second turn uuid = %q, want s-1", rec.UUID)
	}
	if rec.Message.Content[0].Text != "two" {
		t.Errorf("text = %q", rec.Message.Content[0].Text)
	}
}

// TestConversationEmptyRecord confirms no record is produced before any content.
func TestConversationEmptyRecord(t *testing.T) {
	c := NewConversation("s", nil)
	if c.Record() != nil {
		t.Error("empty conversation should render nil")
	}
	if c.Apply(evt(EvSessionStatus, "s", map[string]any{"status": "thinking"})) {
		t.Error("session_status must not complete a turn")
	}
	if c.Record() != nil {
		t.Error("non-content events should not create a record")
	}
}
