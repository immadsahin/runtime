/**
 * Runtime tokens: the short-lived HS256 JWTs the Next control plane mints and
 * the Go runtime-agent verifies (internal/auth). This is the ONLY thing the
 * agent trusts. Kept in lockstep with the Go verifier — both split into three
 * base64url parts, HMAC-SHA256 the first two, and check `exp`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { RuntimeTokenClaims } from "@/lib/runtime/agent-protocol";

/** How long a minted token is valid. Verified at (re)connect time. */
export const RUNTIME_TOKEN_TTL_SECONDS = 300;

const HEADER = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(signingInput: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(signingInput).digest());
}

/**
 * Mint a token for one workspace connection. `exp` defaults to now + TTL; the
 * caller supplies the identity claims (already authorized against Supabase).
 */
export function mintRuntimeToken(
  claims: Omit<RuntimeTokenClaims, "exp"> & { exp?: number },
  secret: string,
): string {
  const full: RuntimeTokenClaims = {
    ...claims,
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + RUNTIME_TOKEN_TTL_SECONDS,
  };
  const payload = base64url(Buffer.from(JSON.stringify(RuntimeTokenClaims.parse(full))));
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

/**
 * Verify a token and return its claims, or throw. Mirrors the Go verifier:
 * fails closed on structure, signature, or expiry.
 */
export function verifyRuntimeToken(
  token: string,
  secret: string,
): RuntimeTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) {
    throw new Error("malformed token");
  }
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid token signature");
  }
  const claims = RuntimeTokenClaims.parse(
    JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
  );
  if (claims.exp > 0 && Math.floor(Date.now() / 1000) > claims.exp) {
    throw new Error("token expired");
  }
  return claims;
}
