// Package protocol mirrors lib/runtime/agent-protocol.ts. The zod schemas on the
// TypeScript side are the source of truth; these structs must stay in sync. The
// shared golden fixtures (lib/runtime/agent-protocol.fixtures.json) are decoded
// by protocol_test.go so the two languages cannot silently drift.
package protocol

import "encoding/json"

// RuntimeTokenClaims is the short-lived token the agent verifies per connection.
type RuntimeTokenClaims struct {
	WorkspaceID string `json:"workspaceId"`
	ProjectID   string `json:"projectId"`
	ComputerID  string `json:"computerId"`
	UserID      string `json:"userId"`
	Exp         int64  `json:"exp"`
}

// PtyClientMessage is a frame from the browser on WS /pty.
// t ∈ {input, resize, ping}.
type PtyClientMessage struct {
	T    string `json:"t"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// PtyServerMessage is a frame from the agent on WS /pty.
// t ∈ {output, role, exit, pong}.
type PtyServerMessage struct {
	T      string `json:"t"`
	Data   string `json:"data,omitempty"`
	Seq    int    `json:"seq,omitempty"`
	Writer *bool  `json:"writer,omitempty"`
	Code   *int   `json:"code,omitempty"`
}

// CreateWorkspaceRequest is the control-plane request to provision a workspace.
type CreateWorkspaceRequest struct {
	WorkspaceID  string `json:"workspaceId"`
	RepoFullName string `json:"repoFullName"`
	Branch       string `json:"branch"`
	BaseBranch   string `json:"baseBranch"`
}

// WorkspaceActionRequest addresses one workspace (start/stop/archive/...).
type WorkspaceActionRequest struct {
	WorkspaceID string `json:"workspaceId"`
}

// ErrorResponse is the stable error envelope for control-plane failures.
type ErrorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// ContentBlock is one block inside a ConversationMessage.
// type ∈ {text, thinking, tool_use, tool_result}.
type ContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"toolUseId,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
}

// ConversationMessage is a structured turn derived from Claude's JSONL.
type ConversationMessage struct {
	T          string         `json:"t"` // "message"
	UUID       string         `json:"uuid"`
	ParentUUID *string        `json:"parentUuid"`
	Role       string         `json:"role"`
	Timestamp  string         `json:"timestamp"`
	Content    []ContentBlock `json:"content"`
}

// TokenUsage is an assistant usage delta.
type TokenUsage struct {
	T                        string `json:"t"` // "usage"
	InputTokens              int    `json:"input_tokens"`
	OutputTokens             int    `json:"output_tokens"`
	CacheCreationInputTokens int    `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int    `json:"cache_read_input_tokens"`
	ServiceTier              string `json:"service_tier,omitempty"`
}

// WorkspaceStateChanged reports a workspace lifecycle transition.
// state ∈ {starting, running, exited, archived, degraded}.
type WorkspaceStateChanged struct {
	T           string `json:"t"` // "state"
	WorkspaceID string `json:"workspaceId"`
	State       string `json:"state"`
}
