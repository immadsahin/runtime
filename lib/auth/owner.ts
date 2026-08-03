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
 *
 * The login is read from the GitHub OAuth identity (see {@link githubLogin}),
 * so this only ever returns true for a user who actually signed in with the
 * allowlisted GitHub account.
 */
export function isOwner(user: User): boolean {
  const allowed = optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN");
  if (!allowed) return false;
  return githubLogin(user)?.toLowerCase() === allowed.toLowerCase();
}

/**
 * The GitHub username, read from the server-maintained OAuth identity — NOT
 * from `user_metadata`.
 *
 * `user_metadata` is writable by the user (`auth.updateUser({ data })`), so if
 * any other Supabase provider is enabled (email/password, magic link, …) a
 * non-GitHub user could set `user_name` to the owner's login and pass the
 * allowlist. `identities[].identity_data` is populated by GoTrue from the
 * provider on each sign-in and is not client-writable, and requiring a
 * `github` identity also enforces that the session actually came from GitHub.
 */
export function githubLogin(user: User): string | null {
  const identity = user.identities?.find((i) => i.provider === "github");
  if (!identity) return null;

  const data = (identity.identity_data ?? {}) as Record<string, unknown>;
  const login = data.user_name ?? data.preferred_username ?? data.login;
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
