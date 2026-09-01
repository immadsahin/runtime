// Package jcode drives a jcode agent through its harness API (protocol v1)
// instead of scraping a terminal. Runtime runs `jcode api-bridge` inside the
// workspace's cloud computer, opens the NDJSON control socket, and translates
// jcode's structured event stream into the Runtime conversation contract
// (internal/protocol). This replaces the Claude-Code path (internal/claude +
// the JSONL tail in internal/conversation): jcode emits typed events over a
// versioned socket, so there is no undocumented log format to parse and no TTY
// REPL to type into.
//
// This file is the wire vocabulary — a Go mirror of the subset of jcode's
// `crates/jcode-harness-api` / `sdk/typescript/src/protocol.ts` that Runtime
// uses. jcode is the source of truth; keep the tag strings below identical to
// the SDK. Every frame carries `v` (the protocol major version); requests are
// tagged with `req`, events with `ev`.
//
// Frame model (mirrors the SDK): a request is `{v, id, req, ...params}`. The
// server answers a request with an event frame that ALSO carries `reply_to ==
// id`; a frame WITHOUT `reply_to` is an unsolicited stream event. So one
// `Frame` type covers both, and `ReplyTo` distinguishes them. Payload fields
// differ per `ev` (and even collide across events — `output` is an int on
// token_usage but a string on tool_done), so the concrete fields are decoded
// on demand from the raw line via Frame.Into rather than flattened here.
package jcode

import "encoding/json"

// APIVersionMajor is the harness-API major version Runtime speaks. The bridge
// rejects a hello outside its supported range with an `unsupported_version`
// error, so this is asserted during the handshake rather than assumed.
const APIVersionMajor = 1

// --- Requests (Runtime → jcode) --------------------------------------------

// Request is one NDJSON frame Runtime sends to the bridge. Only the fields
// relevant to the tag in Req are populated; the rest stay zero and are dropped
// by omitempty. A single struct (rather than a Go interface per request) keeps
// the encoder trivial and matches how the bridge decodes a tagged object. The
// framing layer adds `v` and `id`; callers set only `Req` and its params.
type Request struct {
	Req string `json:"req"`

	// hello
	MinVersion int    `json:"min_version,omitempty"`
	MaxVersion int    `json:"max_version,omitempty"`
	Client     string `json:"client,omitempty"`

	// session-addressed requests (create/attach/send_message/cancel/...)
	SessionID  string `json:"session_id,omitempty"`
	WorkingDir string `json:"working_dir,omitempty"`

	// send_message
	Content string `json:"content,omitempty"`
	// NoReply seeds context without starting a model turn; a pointer so the
	// default (false → the message drives a reply) is unambiguous and an
	// explicit true is never dropped by omitempty.
	NoReply *bool `json:"no_reply,omitempty"`

	// permission_response
	RequestID string `json:"request_id,omitempty"`
	Decision  string `json:"decision,omitempty"` // allow | allow_always | deny

	// set_model
	Model string `json:"model,omitempty"`
}

// Request tag constants — the exact `req` strings jcode accepts.
const (
	ReqHello              = "hello"
	ReqCreateSession      = "create_session"
	ReqAttachSession      = "attach_session"
	ReqSendMessage        = "send_message"
	ReqCancel             = "cancel"
	ReqPermissionResponse = "permission_response"
	ReqSetModel           = "set_model"
	ReqPing               = "ping"
)

// Permission decisions the bridge accepts on a permission_response.
const (
	DecisionAllow       = "allow"
	DecisionAllowAlways = "allow_always"
	DecisionDeny        = "deny"
)

// --- Frames (jcode → Runtime) ----------------------------------------------

// Frame is one NDJSON line from the bridge, decoded down to only the fields
// needed to route it: whether it is a reply (ReplyTo set) or a stream event,
// its kind (Ev), the session it concerns, and the error envelope if Ev ==
// "error". The kind-specific payload stays in raw and is decoded on demand with
// Into, so colliding field types across events never fight in one struct and
// unknown events cost nothing.
type Frame struct {
	// ReplyTo is the request id this frame answers, or nil for a stream event.
	// A pointer, not 0, because id 0 is a valid request id.
	ReplyTo *int `json:"reply_to"`
	// Ev is the event tag. Replies carry one too (e.g. a create_session reply
	// is an `attached` frame with reply_to set).
	Ev        string `json:"ev"`
	SessionID string `json:"session_id"`
	// Error envelope, populated only when Ev == "error".
	Code    string `json:"code"`
	Message string `json:"message"`

	// raw is the original line, kept so Into can decode the kind-specific
	// payload without re-reading the socket. Not a JSON field.
	raw []byte
}

// Into decodes the frame's kind-specific payload (e.g. TextDelta, ToolDone)
// from the original line. It re-parses raw, so the caller switches on Ev first
// and decodes only the matching struct.
func (f Frame) Into(v any) error { return json.Unmarshal(f.raw, v) }

// IsReply reports whether this frame answers a request rather than being an
// unsolicited stream event.
func (f Frame) IsReply() bool { return f.ReplyTo != nil }

// Event tag constants — the exact `ev` strings the translator switches on.
const (
	EvHelloOK           = "hello_ok"
	EvOK                = "ok"
	EvError             = "error"
	EvAttached          = "attached"
	EvTextDelta         = "text_delta"
	EvReasoningDelta    = "reasoning_delta"
	EvReasoningDone     = "reasoning_done"
	EvToolStart         = "tool_start"
	EvToolInputDelta    = "tool_input_delta"
	EvToolExec          = "tool_exec"
	EvToolDone          = "tool_done"
	EvTokenUsage        = "token_usage"
	EvTurnDone          = "turn_done"
	EvMessageAccepted   = "message_accepted"
	EvPermissionRequest = "permission_request"
	EvSessionStatus     = "session_status"
	EvConnectionPhase   = "connection_phase"
)

// --- Kind-specific payloads (decoded from Frame.Into) ----------------------

// SessionInfo is jcode's view of one session, returned inside an `attached`
// frame (the reply to create_session / attach_session).
type SessionInfo struct {
	SessionID  string `json:"session_id"`
	WorkingDir string `json:"working_dir"`
	Title      string `json:"title"`
	Status     string `json:"status"`
}

// HelloOK is the handshake reply payload.
type HelloOK struct {
	Version      int      `json:"version"`
	Server       string   `json:"server"`
	Capabilities []string `json:"capabilities"`
}

// Attached is the create_session / attach_session reply payload.
type Attached struct {
	Session SessionInfo `json:"session"`
}

// TextDelta / ReasoningDelta carry a streaming text fragment.
type TextDelta struct {
	Text string `json:"text"`
}

// ToolStart announces a tool call the assistant is about to make.
type ToolStart struct {
	CallID string `json:"call_id"`
	Name   string `json:"name"`
}

// ToolInputDelta streams the tool's input arguments as they are produced.
type ToolInputDelta struct {
	CallID string `json:"call_id"`
	Delta  string `json:"delta"`
}

// ToolDone reports a finished tool call. Output is the (string) result; Error
// is set instead when the call failed.
type ToolDone struct {
	CallID string `json:"call_id"`
	Name   string `json:"name"`
	Output string `json:"output"`
	Error  string `json:"error"`
}

// TokenUsage is jcode's running per-turn usage. Note `output` here is a token
// COUNT (int), unlike ToolDone.Output (a string) — the reason payloads are
// decoded per-kind rather than flattened.
type TokenUsage struct {
	Input         int `json:"input"`
	Output        int `json:"output"`
	CacheReadInput int `json:"cache_read_input"`
}

// PermissionRequest is issued only when the server advertises the `permissions`
// capability; the current bridge does not, so it never prompts.
type PermissionRequest struct {
	RequestID   string `json:"request_id"`
	ToolName    string `json:"tool_name"`
	Description string `json:"description"`
}

// SessionStatus reports a session lifecycle transition (Status is jcode's own
// string, mapped to the Runtime state vocabulary by the translator).
type SessionStatus struct {
	Status string `json:"status"`
}
