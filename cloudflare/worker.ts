/**
 * Cloudflare Containers entry for the Outrunner control plane.
 *
 * Deploy glue only: this runs the SAME container as Railway (Next.js
 * `next start`, see ../Dockerfile) and forwards every request to it. There are
 * NO application code changes — the swap is purely a provider change.
 *
 * NOTE: the `@cloudflare/containers` API (Container base class, `defaultPort`,
 * `sleepAfter`, `envVars`, `getContainer`) and the wrangler `containers` schema
 * evolve. Verify these names against the current Cloudflare Containers docs
 * before the first deploy; treat this file as scaffolding, not a frozen API.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  CONTROL_PLANE: DurableObjectNamespace<OutrunnerControlPlane>;

  // Secrets forwarded into the container process. Set each with
  // `wrangler secret put <NAME>` (see docs/deploy-cloudflare.md) — never commit
  // them, and never put them in wrangler.jsonc.
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GITHUB_PAT: string;
  DAYTONA_API_KEY: string;
  RUNTIME_OWNER_GITHUB_LOGIN: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
}

export class OutrunnerControlPlane extends Container<Env> {
  // Next.js listens on $PORT (8080) inside the container — keep in sync with
  // the Dockerfile's `ENV PORT`.
  defaultPort = 8080;

  // Keep the instance warm after the last request so the control plane isn't
  // cold on every hit after idle. Trade cost vs first-hit latency here.
  sleepAfter = "20m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Env passed to the container process. Non-secret config is inline; secrets
    // come from Worker bindings (wrangler secret put ...). This mirrors the
    // Railway "Variables" table 1:1 — RUNTIME_BASE_URL is the new domain, which
    // also gates the app's same-origin CSRF checks.
    this.envVars = {
      NODE_ENV: "production",
      PORT: "8080",
      RUNTIME_PROVIDER: "daytona",
      RUNTIME_BASE_URL: "https://outrunner.neev.ai",
      RUNTIME_AGENT_BINARY_PATH: "bin/runtime-agent-linux-amd64",
      DAYTONA_SNAPSHOT: "runtime-computer-v1",
      RUNTIME_OWNER_GITHUB_LOGIN: env.RUNTIME_OWNER_GITHUB_LOGIN,
      NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      GITHUB_PAT: env.GITHUB_PAT,
      DAYTONA_API_KEY: env.DAYTONA_API_KEY,
      ...(env.CLAUDE_CODE_OAUTH_TOKEN
        ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
        : {}),
      ...(env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
        : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One logical control-plane instance; route everything to it. Provisioning
    // is elected atomically in Postgres, so sharding to multiple instances later
    // (e.g. by project id) stays safe.
    return getContainer(env.CONTROL_PLANE).fetch(request);
  },
};
