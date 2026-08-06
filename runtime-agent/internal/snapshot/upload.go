package snapshot

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"

	"runtime-agent/internal/protocol"
)

// httpClient is the client Produce uploads artifacts with. A package var so
// tests can point it at an httptest server; production uses the default.
var httpClient = http.DefaultClient

// uploadAll PUTs each artifact's bytes to its signed URL. The manifest is
// uploaded LAST — its arrival in storage is the marker that the Snapshot is
// complete, so no consumer may observe a manifest that points at not-yet-present
// artifacts. Every non-manifest artifact must have a local file; a requested
// artifact we don't recognize is an error rather than a silent skip.
func uploadAll(ctx context.Context, uploads []protocol.ArchiveUpload, paths map[string]string) error {
	// Every artifact must have an upload URL BEFORE we push anything — otherwise a
	// request carrying only some URLs could write a manifest that points at absent
	// objects, persisting an incomplete Snapshot that Replay/Restore can't read.
	byArtifact := map[string]string{}
	for _, up := range uploads {
		if _, ok := artifactFile[up.Artifact]; !ok {
			return fmt.Errorf("upload requested for unknown artifact %q", up.Artifact)
		}
		byArtifact[up.Artifact] = up.URL
	}
	for artifact := range artifactFile {
		if byArtifact[artifact] == "" {
			return fmt.Errorf("archive request is missing the %s upload URL", artifact)
		}
	}

	// Payload artifacts first; the manifest LAST — its arrival marks the Snapshot
	// complete, so it must never precede an artifact it points at.
	for _, artifact := range payloadArtifacts {
		if err := putFile(ctx, byArtifact[artifact], paths[artifact]); err != nil {
			return fmt.Errorf("upload %s: %w", artifact, err)
		}
	}
	if err := putFile(ctx, byArtifact["manifest"], paths["manifest"]); err != nil {
		return fmt.Errorf("upload manifest: %w", err)
	}
	return nil
}

// putFile streams a file to a signed upload URL with an HTTP PUT.
func putFile(ctx context.Context, url, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size()
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("unexpected status %d: %s", resp.StatusCode, body)
	}
	// Drain the body so the transport can reuse the connection for the next of the
	// six sequential uploads (avoids a fresh TLS handshake per artifact).
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}
