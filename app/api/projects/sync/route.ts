import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { upsertProjects } from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import {
  GitHubSyncError,
  listGitHubRepositories,
} from "@/lib/github/client";

export const dynamic = "force-dynamic";

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  // A configured public origin takes precedence over request headers, which
  // avoids trusting a forwarded host at a proxy boundary.
  const baseUrl = optionalEnv("RUNTIME_BASE_URL") ?? request.url;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Synchronize repositories accessible to the owner's server-side GitHub PAT. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "Sign in as the Runtime owner." },
      { status: 401 },
    );
  }

  try {
    const repositories = await listGitHubRepositories(owner.githubLogin);
    const synced = await upsertProjects(owner.id, repositories);
    return NextResponse.json({ synced, discovered: repositories.length });
  } catch (error) {
    if (error instanceof GitHubSyncError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }

    console.error("Repository sync failed", error);
    return NextResponse.json(
      { error: "Could not save repositories. Check Runtime setup and try again." },
      { status: 500 },
    );
  }
}
