# syntax=docker/dockerfile:1

# Control-plane image for Cloudflare Containers — a faithful lift of the Railway
# `next start` container. The whole built app stays on disk (NOT a standalone
# bundle), so lib/runtime/daytona-provider.ts can read
# bin/runtime-agent-linux-amd64 at runtime exactly as it does on Railway.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- build: install (frozen) + next build ----------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runtime: the same `next start` the Railway deploy uses ------------------
FROM base AS runtime
ENV NODE_ENV=production
# Cloudflare Containers routes to the port the process listens on; `pnpm start`
# is `next start --port ${PORT}`. Keep this in sync with defaultPort in
# cloudflare/worker.ts. (On Railway, PORT is injected instead — same binary.)
ENV PORT=8080
COPY --from=build /app /app
EXPOSE 8080
CMD ["pnpm", "start"]
