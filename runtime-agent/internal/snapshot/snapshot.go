// Package snapshot PRODUCES a Workspace Snapshot: the agent-side half of M4's
// Archive flow. It captures the terminal cast, the Claude conversation JSONL,
// the git tree (bundle + uncommitted patch), and the Workspace Summary into a
// set of immutable artifacts, assembles the manifest that addresses them, and
// uploads everything to object storage through signed URLs minted by Next.
//
// The manifest is the contract (docs/architecture/m4-plan.md): every consumer
// reads manifest.json and follows its pointers; nothing enumerates storage. The
// manifest is uploaded LAST, so its presence marks the Snapshot complete.
//
// This package only PRODUCES. Replay/Restore consume the manifest elsewhere.
package snapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"runtime-agent/internal/protocol"
)

// RuntimeVersion is the agent build stamped into every manifest. Overridden at
// build time via `-ldflags "-X runtime-agent/internal/snapshot.RuntimeVersion=..."`;
// "dev" is the honest default for an un-stamped local build.
var RuntimeVersion = "dev"

// Artifact filenames — the Go MIRROR of lib/runtime/snapshot/manifest.ts
// SNAPSHOT_ARTIFACTS (the TS side is the source of truth). The manifest carries
// these relative names only; the storage path scheme lives entirely on the Next
// side, since Next mints the upload URLs.
const (
	ConversationName = "conversation.jsonl"
	CastName         = "session.cast"
	BundleName       = "worktree.bundle"
	PatchName        = "uncommitted.patch"
	SummaryName      = "summary.json"
	ManifestName     = "manifest.json"

	TreeKindGitBundlePatch = "git-bundle+patch"
)

// payloadArtifacts are the artifacts whose bytes are checksummed and referenced
// by the manifest. The manifest itself is excluded — it can't checksum itself,
// and it's written last as the completion marker.
var payloadArtifacts = []string{"conversation", "cast", "bundle", "patch", "summary"}

// artifactFile maps an upload artifact key (as sent by Next) to its filename.
var artifactFile = map[string]string{
	"conversation": ConversationName,
	"cast":         CastName,
	"bundle":       BundleName,
	"patch":        PatchName,
	"summary":      SummaryName,
	"manifest":     ManifestName,
}

// Tree is the filesystem capture, behind an interface (manifest.tree.kind). v0
// is a git bundle (committed history) + a patch of the uncommitted working tree.
type Tree struct {
	Kind   string `json:"kind"`
	Bundle string `json:"bundle"`
	Patch  string `json:"patch"`
}

// Manifest is the Go MIRROR of the zod SnapshotManifest
// (lib/runtime/snapshot/manifest.ts) — the single contract addressing a
// Snapshot. Keep the JSON shape byte-compatible: Next re-parses this response
// against the zod schema before caching it on the workspace_snapshots row.
type Manifest struct {
	Version        int     `json:"version"`
	WorkspaceID    string  `json:"workspaceId"`
	RuntimeVersion string  `json:"runtimeVersion"`
	ClaudeVersion  string  `json:"claudeVersion"`
	SessionID      *string `json:"sessionId"`

	Conversation string `json:"conversation"`
	Cast         string `json:"cast"`
	Tree         Tree   `json:"tree"`
	Summary      string `json:"summary"`

	Checksums map[string]string `json:"checksums"`
	Sizes     map[string]int64  `json:"sizes"`

	StartedAt  string `json:"startedAt"`
	ArchivedAt string `json:"archivedAt"`

	LastCommit   *string        `json:"lastCommit"`
	LastMessage  *string        `json:"lastMessage"`
	TokenUsage   map[string]int `json:"tokenUsage"`
	ChangedFiles int            `json:"changedFiles"`
}

// Input is everything Produce needs to capture and upload one Snapshot.
type Input struct {
	WorkspaceID string
	// Worktree is the workspace's git worktree (source of the tree + last commit).
	Worktree string
	// CastPath is the finalized session.cast on disk (may not exist if the session
	// never recorded — Produce then stages an empty cast so the artifact is present).
	CastPath string
	// ConversationPath is Claude's current session JSONL, or "" when Claude never
	// wrote one (Produce then stages an empty conversation).
	ConversationPath string
	// SessionID feeds `claude --continue` on Restore; nil when absent.
	SessionID *string
	// Summary is the Workspace Summary snapshotted into the manifest + summary.json.
	Summary protocol.WorkspaceSummary
	// ArchivedAt is echoed verbatim into the manifest so it matches the storage
	// prefix Next derived from the same value.
	ArchivedAt string
	// Uploads is one signed URL per artifact (from Next).
	Uploads []protocol.ArchiveUpload
	// ClaudeVersion is resolved by the caller (shelling `claude --version`).
	ClaudeVersion string
}

// Produce captures the Snapshot artifacts, assembles the manifest, and uploads
// every artifact through the provided signed URLs — manifest LAST. It returns
// the manifest so Next can cache it on the workspace_snapshots row.
func Produce(ctx context.Context, in Input) (*Manifest, error) {
	staging, err := os.MkdirTemp("", "snapshot-")
	if err != nil {
		return nil, fmt.Errorf("snapshot staging dir: %w", err)
	}
	defer os.RemoveAll(staging)

	// Resolve each payload artifact to a concrete file on disk (staging the ones
	// we generate; reusing the cast/JSONL in place when they already exist).
	paths := map[string]string{}

	paths["conversation"], err = stageConversation(staging, in.ConversationPath)
	if err != nil {
		return nil, err
	}
	paths["cast"], err = stageCast(staging, in.CastPath)
	if err != nil {
		return nil, err
	}
	paths["bundle"], err = buildBundle(ctx, in.Worktree, filepath.Join(staging, BundleName))
	if err != nil {
		return nil, err
	}
	paths["patch"], err = buildPatch(ctx, in.Worktree, filepath.Join(staging, PatchName))
	if err != nil {
		return nil, err
	}
	paths["summary"], err = stageSummary(staging, in.Summary)
	if err != nil {
		return nil, err
	}

	checksums := map[string]string{}
	sizes := map[string]int64{}
	for _, artifact := range payloadArtifacts {
		sum, size, err := checksumFile(paths[artifact])
		if err != nil {
			return nil, err
		}
		name := artifactFile[artifact]
		checksums[name] = sum
		sizes[name] = size
	}

	manifest := &Manifest{
		Version:        1,
		WorkspaceID:    in.WorkspaceID,
		RuntimeVersion: RuntimeVersion,
		ClaudeVersion:  fallback(in.ClaudeVersion, "unknown"),
		SessionID:      in.SessionID,
		Conversation:   ConversationName,
		Cast:           CastName,
		Tree:           Tree{Kind: TreeKindGitBundlePatch, Bundle: BundleName, Patch: PatchName},
		Summary:        SummaryName,
		Checksums:      checksums,
		Sizes:          sizes,
		StartedAt:      in.Summary.StartedAt,
		ArchivedAt:     in.ArchivedAt,
		LastCommit:     lastCommit(ctx, in.Worktree),
		LastMessage:    in.Summary.LastAssistantMessage,
		TokenUsage:     tokenUsageMap(in.Summary.TokenUsage),
		ChangedFiles:   in.Summary.ChangedFiles,
	}

	manifestPath := filepath.Join(staging, ManifestName)
	if err := writeJSON(manifestPath, manifest); err != nil {
		return nil, err
	}
	paths["manifest"] = manifestPath

	if err := uploadAll(ctx, in.Uploads, paths); err != nil {
		return nil, err
	}
	return manifest, nil
}

// stageConversation returns the JSONL path to upload — the live session log when
// it exists, otherwise a freshly staged empty file so the artifact is always
// present.
func stageConversation(staging, sessionLog string) (string, error) {
	if sessionLog != "" {
		if _, err := os.Stat(sessionLog); err == nil {
			return sessionLog, nil
		}
	}
	empty := filepath.Join(staging, ConversationName)
	return empty, os.WriteFile(empty, nil, 0o644)
}

// stageCast returns the finalized cast path, or a staged empty file when the
// session never recorded (recording is best-effort; a missing cast must not fail
// the archive).
func stageCast(staging, castPath string) (string, error) {
	if castPath != "" {
		if _, err := os.Stat(castPath); err == nil {
			return castPath, nil
		}
	}
	empty := filepath.Join(staging, CastName)
	return empty, os.WriteFile(empty, nil, 0o644)
}

func stageSummary(staging string, summary protocol.WorkspaceSummary) (string, error) {
	path := filepath.Join(staging, SummaryName)
	return path, writeJSON(path, summary)
}

func writeJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", filepath.Base(path), err)
	}
	return os.WriteFile(path, data, 0o644)
}

// checksumFile returns the `sha256:<hex>` digest and byte size of a file.
func checksumFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, fmt.Errorf("checksum %s: %w", filepath.Base(path), err)
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), n, nil
}

func tokenUsageMap(u protocol.TokenUsageAmounts) map[string]int {
	return map[string]int{
		"input_tokens":                u.InputTokens,
		"output_tokens":               u.OutputTokens,
		"cache_creation_input_tokens": u.CacheCreationInputTokens,
		"cache_read_input_tokens":     u.CacheReadInputTokens,
	}
}

// ClaudeVersion resolves the installed Claude Code version, or "" if `claude` is
// unavailable (kept best-effort — a missing CLI must not fail an archive).
func ClaudeVersion(ctx context.Context) string {
	out, err := exec.CommandContext(ctx, "claude", "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func fallback(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}
