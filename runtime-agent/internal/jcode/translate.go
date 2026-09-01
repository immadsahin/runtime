package jcode

import (
	"encoding/json"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

// Conversation assembles one jcode session's streaming event frames into
// Claude-shaped JSONL records — the exact record shape internal/conversation.
// Watcher already tails. Writing that shape lets the SSE /events pipeline and
// its byte-offset resume be reused unchanged: only the *producer* of the log
// changes (jcode events instead of Claude's own JSONL).
//
// jcode streams deltas (text_delta, tool_input_delta); the conversation UI
// wants whole messages. Conversation accumulates a turn's deltas into ordered
// content blocks and renders the in-progress assistant message on demand. A
// caller that renders repeatedly during a turn (for streaming) emits the same
// uuid each time, so the timeline upserts by uuid; a caller that renders once
// at turn end emits each turn once. Not safe for concurrent use — drive one
// Conversation per session from a single goroutine.
type Conversation struct {
	sessionID string
	clock     func() time.Time
	turn      int
	cur       *turnState
}

// turnState is the in-progress assistant message. Text/thinking accumulate into
// builders reconciled into their blocks at render time; tool calls track the
// block index so their streamed input lands in the right place.
type turnState struct {
	uuid     string
	blocks   []protocol.ContentBlock
	textBuf  *strings.Builder
	textIdx  int // index of the open trailing text block, or -1
	thinkBuf *strings.Builder
	thinkIdx int
	toolBuf  map[string]*strings.Builder
	toolIdx  map[string]int
}

// NewConversation starts an assembler for one session. clock supplies record
// timestamps (injectable so tests are deterministic).
func NewConversation(sessionID string, clock func() time.Time) *Conversation {
	if clock == nil {
		clock = time.Now
	}
	return &Conversation{sessionID: sessionID, clock: clock}
}

// Apply folds one event frame into the current turn. It reports whether the
// turn just completed (turn_done), which the caller uses to render a final
// record and then Reset. Frames for other event kinds (session_status, usage,
// permission prompts) are ignored here — the caller handles those separately.
func (c *Conversation) Apply(f Frame) (turnComplete bool) {
	switch f.Ev {
	case EvTextDelta:
		var p TextDelta
		if f.Into(&p) == nil {
			c.appendText(&p.Text)
		}
	case EvReasoningDelta:
		var p TextDelta
		if f.Into(&p) == nil {
			c.appendThinking(p.Text)
		}
	case EvReasoningDone:
		c.closeThinking()
	case EvToolStart:
		var p ToolStart
		if f.Into(&p) == nil {
			c.startTool(p.CallID, p.Name)
		}
	case EvToolInputDelta:
		var p ToolInputDelta
		if f.Into(&p) == nil {
			c.appendToolInput(p.CallID, p.Delta)
		}
	case EvToolDone:
		var p ToolDone
		if f.Into(&p) == nil {
			c.finishTool(p)
		}
	case EvTurnDone:
		return true
	}
	return false
}

// Record renders the in-progress assistant message as one Claude-shaped JSONL
// line (terminated by '\n'), or nil when the turn is empty. Safe to call
// repeatedly; each call reflects everything accumulated so far.
func (c *Conversation) Record() []byte {
	if c.cur == nil || len(c.cur.blocks) == 0 {
		return nil
	}
	c.reconcile()
	rec := claudeRecord{
		Type:      "assistant",
		UUID:      c.cur.uuid,
		Timestamp: c.clock().UTC().Format(time.RFC3339Nano),
	}
	rec.Message.Role = "assistant"
	rec.Message.Content = c.cur.blocks
	line, err := json.Marshal(rec)
	if err != nil {
		return nil
	}
	return append(line, '\n')
}

// Reset ends the current turn so the next event starts a fresh message with a
// new uuid. Call after rendering a completed turn.
func (c *Conversation) Reset() { c.cur = nil }

// claudeRecord is the on-disk JSONL line: exactly the subset
// conversation.Watcher decodes. Reusing protocol.ContentBlock guarantees the
// blocks round-trip through the watcher into the frontend byte-for-byte.
type claudeRecord struct {
	Type      string  `json:"type"`
	UUID      string  `json:"uuid"`
	ParentID  *string `json:"parentUuid"`
	Timestamp string  `json:"timestamp"`
	Message   struct {
		Role    string                  `json:"role"`
		Content []protocol.ContentBlock `json:"content"`
	} `json:"message"`
}

func (c *Conversation) ensureTurn() {
	if c.cur == nil {
		c.cur = &turnState{
			uuid:     c.sessionID + "-" + itoa(c.turn),
			textIdx:  -1,
			thinkIdx: -1,
			toolBuf:  map[string]*strings.Builder{},
			toolIdx:  map[string]int{},
		}
		c.turn++
	}
}

func (c *Conversation) appendText(delta *string) {
	c.ensureTurn()
	if c.cur.textIdx < 0 {
		c.cur.blocks = append(c.cur.blocks, protocol.ContentBlock{Type: "text"})
		c.cur.textIdx = len(c.cur.blocks) - 1
		c.cur.textBuf = &strings.Builder{}
	}
	c.cur.textBuf.WriteString(*delta)
}

func (c *Conversation) appendThinking(delta string) {
	c.ensureTurn()
	c.flushText() // a thinking block interrupts and closes the trailing text block
	if c.cur.thinkIdx < 0 {
		c.cur.blocks = append(c.cur.blocks, protocol.ContentBlock{Type: "thinking"})
		c.cur.thinkIdx = len(c.cur.blocks) - 1
		c.cur.thinkBuf = &strings.Builder{}
	}
	c.cur.thinkBuf.WriteString(delta)
}

func (c *Conversation) closeThinking() {
	c.flushThinking()
}

func (c *Conversation) startTool(callID, name string) {
	c.ensureTurn()
	c.flushText() // close any open text/thinking so block order is preserved
	c.flushThinking()
	c.cur.blocks = append(c.cur.blocks, protocol.ContentBlock{Type: "tool_use", ID: callID, Name: name})
	c.cur.toolIdx[callID] = len(c.cur.blocks) - 1
	c.cur.toolBuf[callID] = &strings.Builder{}
}

func (c *Conversation) appendToolInput(callID, delta string) {
	c.ensureTurn()
	b, ok := c.cur.toolBuf[callID]
	if !ok {
		b = &strings.Builder{}
		c.cur.toolBuf[callID] = b
	}
	b.WriteString(delta)
}

// finishTool appends a tool_result block for a completed call. Its input has
// been streamed already and lands on the tool_use block at reconcile time.
func (c *Conversation) finishTool(p ToolDone) {
	c.ensureTurn()
	c.flushText()
	content := p.Output
	if p.Error != "" {
		content = p.Error
	}
	c.cur.blocks = append(c.cur.blocks, protocol.ContentBlock{
		Type:      "tool_result",
		ToolUseID: p.CallID,
		Content:   jsonString(content),
	})
}

// syncText copies the open text block's accumulated content into the block
// WITHOUT closing it, so streaming Record calls reflect growth and the next
// text_delta keeps extending the same block.
func (c *Conversation) syncText() {
	if c.cur != nil && c.cur.textIdx >= 0 && c.cur.textBuf != nil {
		c.cur.blocks[c.cur.textIdx].Text = c.cur.textBuf.String()
	}
}

// syncThinking is syncText's counterpart for the open reasoning block.
func (c *Conversation) syncThinking() {
	if c.cur != nil && c.cur.thinkIdx >= 0 && c.cur.thinkBuf != nil {
		c.cur.blocks[c.cur.thinkIdx].Text = c.cur.thinkBuf.String()
	}
}

// flushText syncs then CLOSES the trailing text block, so an interrupting block
// (tool/thinking) does not strand its text and later text starts a new block.
func (c *Conversation) flushText() {
	if c.cur == nil || c.cur.textIdx < 0 {
		return
	}
	c.syncText()
	c.cur.textIdx = -1
	c.cur.textBuf = nil
}

// flushThinking syncs then closes the trailing reasoning block.
func (c *Conversation) flushThinking() {
	if c.cur == nil || c.cur.thinkIdx < 0 {
		return
	}
	c.syncThinking()
	c.cur.thinkIdx = -1
	c.cur.thinkBuf = nil
}

// reconcile writes every builder still open into its block. Closed blocks were
// synced at close time; this syncs the currently-open text/thinking block
// (without closing it) and every tool's streamed input. Idempotent, so Record
// can be called repeatedly during a turn (streaming).
func (c *Conversation) reconcile() {
	c.syncText()
	c.syncThinking()
	for callID, idx := range c.cur.toolIdx {
		c.cur.blocks[idx].Input = rawInput(c.cur.toolBuf[callID])
	}
}

// rawInput turns jcode's streamed tool-input string into the tool_use `input`
// field: pass valid JSON through verbatim, wrap anything else as a JSON string,
// and default an empty/absent input to `{}`.
func rawInput(b *strings.Builder) json.RawMessage {
	if b == nil || b.Len() == 0 {
		return json.RawMessage("{}")
	}
	s := b.String()
	if json.Valid([]byte(s)) {
		return json.RawMessage(s)
	}
	return jsonString(s)
}

// jsonString marshals s as a JSON string value, falling back to an empty string
// if (impossibly) marshalling fails.
func jsonString(s string) json.RawMessage {
	b, err := json.Marshal(s)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return b
}

// itoa avoids pulling strconv for a single small non-negative int.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
