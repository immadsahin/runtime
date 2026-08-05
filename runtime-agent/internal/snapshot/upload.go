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
	var manifest *protocol.ArchiveUpload
	for i := range uploads {
		up := uploads[i]
		if up.Artifact == "manifest" {
			manifest = &up
			continue
		}
		path, ok := paths[up.Artifact]
		if !ok {
			return fmt.Errorf("upload requested for unknown artifact %q", up.Artifact)
		}
		if err := putFile(ctx, up.URL, path); err != nil {
			return fmt.Errorf("upload %s: %w", up.Artifact, err)
		}
	}
	if manifest == nil {
		return fmt.Errorf("archive request is missing the manifest upload URL")
	}
	if err := putFile(ctx, manifest.URL, paths["manifest"]); err != nil {
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
	return nil
}
