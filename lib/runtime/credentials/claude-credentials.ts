import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";

/**
 * Per-user Claude Code credential storage.
 *
 * Each owner may store their own `claude setup-token` OAuth token so their
 * sandboxes run on their subscription instead of the platform credentials
 * (see {@link runtimeSessionEnvironment}). The token is encrypted at rest with
 * {@link encryptSecret} and lives in `user_claude_credentials`, a table the
 * anon key can never read (RLS on, no policies — only the service-role client
 * touches it). The ciphertext therefore never reaches the browser; UI is
 * limited to the presence/last-4 metadata from {@link getClaudeTokenMeta}.
 */

const TABLE = "user_claude_credentials";

type DbError = { message: string } | null;

/**
 * The narrow slice of the Supabase client this module uses. Declaring it
 * explicitly (rather than the full client type) lets tests inject a fake.
 */
export interface CredentialsDb {
  from(table: string): {
    upsert(values: Record<string, unknown>): Promise<{ error: DbError }>;
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: Record<string, unknown> | null;
          error: DbError;
        }>;
      };
    };
    delete(): {
      eq(column: string, value: string): Promise<{ error: DbError }>;
    };
  };
}

export type ClaudeTokenMeta = {
  /** Whether the owner has stored a token. */
  connected: boolean;
  /** Last 4 characters, for the UI to confirm which token — never the token. */
  last4: string | null;
};

// Resolved lazily so importing this module (e.g. in unit tests with an injected
// fake) never pulls in the Next-only `next/headers` dependency of the Supabase
// server client. The service-role client bypasses RLS; this table has no other
// reader.
async function defaultDb(): Promise<CredentialsDb> {
  const { createSupabaseAdminClient } = await import("@/lib/supabase/server");
  return createSupabaseAdminClient() as unknown as CredentialsDb;
}

/** Store (or replace) the owner's Claude token, encrypted at rest. */
export async function setClaudeToken(
  ownerId: string,
  token: string,
  injectedDb?: CredentialsDb,
): Promise<void> {
  const db = injectedDb ?? (await defaultDb());
  const { error } = await db.from(TABLE).upsert({
    owner_id: ownerId,
    token_ciphertext: encryptSecret(token),
    token_last4: token.slice(-4),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not save Claude token: ${error.message}`);
}

/** The owner's decrypted token, or null when they have not stored one. */
export async function getClaudeToken(
  ownerId: string,
  injectedDb?: CredentialsDb,
): Promise<string | null> {
  const db = injectedDb ?? (await defaultDb());
  const { data, error } = await db
    .from(TABLE)
    .select("token_ciphertext")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read Claude token: ${error.message}`);
  const ciphertext = data?.token_ciphertext;
  if (typeof ciphertext !== "string") return null;
  return decryptSecret(ciphertext);
}

/** Presence + last-4 metadata safe to expose to the signed-in owner. */
export async function getClaudeTokenMeta(
  ownerId: string,
  injectedDb?: CredentialsDb,
): Promise<ClaudeTokenMeta> {
  const db = injectedDb ?? (await defaultDb());
  const { data, error } = await db
    .from(TABLE)
    .select("token_last4")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read Claude token metadata: ${error.message}`);
  }
  const last4 = data?.token_last4;
  return {
    connected: data != null,
    last4: typeof last4 === "string" ? last4 : null,
  };
}

/** Remove the owner's stored token (disconnect). */
export async function deleteClaudeToken(
  ownerId: string,
  injectedDb?: CredentialsDb,
): Promise<void> {
  const db = injectedDb ?? (await defaultDb());
  const { error } = await db.from(TABLE).delete().eq("owner_id", ownerId);
  if (error) throw new Error(`Could not delete Claude token: ${error.message}`);
}
