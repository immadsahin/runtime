# runtime-computer-e2b-v1 — isolated Runtime Computer image for E2B.
#
# E2B is a Firecracker microVM (real kernel), so unlike the gVisor Daytona image
# this one bakes a real Docker engine + Compose. It mirrors the Daytona
# runtime-computer-v1 toolchain and the deploy seam's on-box contract:
#   - non-root `runtime` user, home /home/runtime  (Claude refuses
#     bypassPermissions as root; the agent uploads to /home/runtime)
#   - passwordless sudo + docker group so the agent can start dockerd
# The runtime-agent binary is NOT baked in — it is uploaded at provision time
# (deploy.ts BoxIO seam), matching the Daytona path.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base toolchain (matches the image contract in e2b-provider-spike.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git git-lfs tmux jq ripgrep \
      python3 python3-pip build-essential sudo iproute2 openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Docker engine + Compose plugin (real kernel → dind works).
RUN install -m0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# Node 24 + Claude Code.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @anthropic-ai/claude-code \
 && rm -rf /var/lib/apt/lists/*

# Go (parity with the Daytona image; supports in-box builds).
RUN curl -fsSL https://go.dev/dl/go1.23.4.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/home/runtime/go/bin:${PATH}"

# Non-root runtime user with passwordless sudo (to start dockerd) + docker group.
# No fixed uid: the E2B base already occupies 1001, so let useradd pick a free one.
RUN useradd -m -s /bin/bash runtime \
 && usermod -aG docker runtime \
 && echo 'runtime ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runtime \
 && chmod 0440 /etc/sudoers.d/runtime \
 && chown -R runtime:runtime /home/runtime

USER runtime
WORKDIR /home/runtime
