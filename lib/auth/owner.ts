import type { User } from "@supabase/supabase-js";

import { optionalEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Owner = {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
};

/**
 * Runtime is single-user by design. Identity comes from GitHub OAuth, and
 * `RUNTIME_OWNER_GITHUB_LOGIN` is the allowlist: exactly one account may use
 * this deployment. This is the entire authorization model — no roles, no teams.
 */
export function isOwner(user: User): boolean {
  const allowed = optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN");
  if (!allowed) return false;
  return githubLogin(user)?.toLowerCase() === allowed.toLowerCase();
}

export function githubLogin(user: User): string | null {
  const meta = user.user_metadata as Record<string, unknown> | null;
  const login = meta?.user_name ?? meta?.preferred_username ?? meta?.login;
  return typeof login === "string" ? login : null;
}

/** The signed-in owner, or null when signed out or not the allowlisted user. */
export async function getOwner(): Promise<Owner | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isOwner(user)) return null;

  const meta = user.user_metadata as Record<string, unknown> | null;
  return {
    id: user.id,
    githubLogin: githubLogin(user) ?? "",
    email: user.email ?? null,
    avatarUrl:
      typeof meta?.avatar_url === "string" ? meta.avatar_url : null,
  };
}

/**
 * Like {@link getOwner} but never throws. Before Supabase is configured the
 * server client throws on missing env; UI (the app shell, the sign-in page)
 * must still render so `/setup` can guide configuration, so it treats any
 * failure as "signed out".
 */
export async function getOwnerSafe(): Promise<Owner | null> {
  try {
    return await getOwner();
  } catch {
    return null;
  }
}

/** Route-handler guard: returns the owner or throws an unauthorized error. */
export async function requireOwner(): Promise<Owner> {
  const owner = await getOwner();
  if (!owner) throw new UnauthorizedError();
  return owner;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Not signed in as the Runtime owner.");
    this.name = "UnauthorizedError";
  }
}
