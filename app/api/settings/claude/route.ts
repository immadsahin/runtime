import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import {
  deleteClaudeToken,
  getClaudeTokenMeta,
  setClaudeToken,
} from "@/lib/runtime/credentials/claude-credentials";

export const dynamic = "force-dynamic";

/**
 * Per-user Claude Code credential. The owner stores a `claude setup-token`
 * OAuth token so their sandboxes run on their own subscription.
 *
 * GET returns only presence + last-4 metadata; the token itself is never
 * returned once stored. Validation is deliberately lazy (format-only here) —
 * an invalid token surfaces at sandbox launch, not on save.
 */

// setup-token output is an opaque OAuth token; keep the check permissive so a
// format change upstream never blocks a valid token — just guard obvious junk.
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 500;

function unauthorized() {
  return NextResponse.json(
    { error: "Sign in as the Runtime owner." },
    { status: 401 },
  );
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return unauthorized();

  const meta = await getClaudeTokenMeta(owner.id);
  return NextResponse.json(meta);
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const raw = (body as { token?: unknown })?.token;
  const token = typeof raw === "string" ? raw.trim() : "";
  if (
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH ||
    /\s/.test(token)
  ) {
    return NextResponse.json(
      { error: "That doesn't look like a Claude token. Paste the value from `claude setup-token`." },
      { status: 400 },
    );
  }

  await setClaudeToken(owner.id, token);
  return NextResponse.json(await getClaudeTokenMeta(owner.id));
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  await deleteClaudeToken(owner.id);
  return NextResponse.json({ connected: false, last4: null });
}
