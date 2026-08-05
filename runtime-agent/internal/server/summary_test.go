package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"runtime-agent/internal/protocol"
)

func TestSummaryRequiresValidToken(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()
	resp, err := http.Get(fmt.Sprintf("%s/workspaces/%s/summary", f.url, f.workspaceID))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestSummaryReturnsCanonicalShape(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	req, err := http.NewRequest("GET", fmt.Sprintf("%s/workspaces/%s/summary", f.url, f.workspaceID), nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+f.token(t))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, string(body))
	}

	var summary protocol.WorkspaceSummary
	if err := json.NewDecoder(resp.Body).Decode(&summary); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The workspace was never Start()ed in the fixture, so the summary is
	// synthesized. Assert the shape — every canonical field is present with
	// its documented type and correct zero value.
	if summary.State != "starting" {
		t.Fatalf("state = %q, want starting", summary.State)
	}
	if summary.StartedAt == "" {
		t.Fatal("startedAt must be non-empty (RFC3339 timestamp)")
	}
	if summary.EndedAt != nil {
		t.Fatalf("endedAt should be nil while starting, got %v", *summary.EndedAt)
	}
	if summary.Duration != 0 {
		t.Fatalf("duration = %d, want 0 for starting summary", summary.Duration)
	}
	if summary.LastActivity == "" {
		t.Fatal("lastActivity must be non-empty (RFC3339 timestamp)")
	}
	// TokenUsageAmounts must serialize even when zero — Mission Engine relies
	// on the field being present, not conditionally omitted.
	if summary.TokenUsage != (protocol.TokenUsageAmounts{}) {
		t.Fatalf("tokenUsage should be zero-valued, got %+v", summary.TokenUsage)
	}
	if summary.ChangedFiles != 0 {
		t.Fatalf("changedFiles = %d, want 0", summary.ChangedFiles)
	}
	if summary.FilesTouched == nil {
		t.Fatal("filesTouched should be [] (JSON), not null — check JSON encoding")
	}
	if len(summary.FilesTouched) != 0 {
		t.Fatalf("filesTouched should be empty, got %v", summary.FilesTouched)
	}
	if summary.CommitCount != 0 {
		t.Fatalf("commitCount = %d, want 0", summary.CommitCount)
	}
	if summary.LastAssistantMessage != nil {
		t.Fatalf("lastAssistantMessage should be nil, got %v", *summary.LastAssistantMessage)
	}
}
