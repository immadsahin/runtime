#!/usr/bin/env bash
# Cross-compile the runtime-agent to a static linux/amd64 binary for upload to a
# Runtime Computer (decision 1A: upload-on-provision). Output is gitignored under
# .context/build; the Daytona provider reads it (RUNTIME_AGENT_BINARY_PATH).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$repo_root/.context/build/runtime-agent-linux-amd64}"
mkdir -p "$(dirname "$out")"

cd "$repo_root/runtime-agent"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
  -trimpath -ldflags="-s -w" \
  -o "$out" ./cmd/runtime-agent

echo "built $out ($(du -h "$out" | cut -f1))"
