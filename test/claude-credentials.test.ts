import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import {
  type CredentialsDb,
  deleteClaudeToken,
  getClaudeToken,
  getClaudeTokenMeta,
  setClaudeToken,
} from "@/lib/runtime/credentials/claude-credentials";

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
});

/**
 * An in-memory stand-in for the service-role Supabase client, keyed by owner_id.
 * Records upsert values verbatim so tests can assert what was persisted.
 */
function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map<string, Record<string, unknown>>(Object.entries(seed));
  let lastUpsert: Record<string, unknown> | null = null;
  let failWith: string | null = null;

  const db: CredentialsDb = {
    from() {
      return {
        upsert: async (values) => {
          if (failWith) return { error: { message: failWith } };
          lastUpsert = values;
          rows.set(String(values.owner_id), values);
          return { error: null };
        },
        select: (columns: string) => ({
          eq: (_column, value) => ({
            maybeSingle: async () => {
              if (failWith) return { data: null, error: { message: failWith } };
              const row = rows.get(value);
              if (!row) return { data: null, error: null };
              const projected: Record<string, unknown> = {};
              for (const key of columns.split(",").map((c) => c.trim())) {
                projected[key] = row[key];
              }
              return { data: projected, error: null };
            },
          }),
        }),
        delete: () => ({
          eq: async (_column, value) => {
            if (failWith) return { error: { message: failWith } };
            rows.delete(value);
            return { error: null };
          },
        }),
      };
    },
  };

  return {
    db,
    rows,
    lastUpsert: () => lastUpsert,
    fail: (message: string) => {
      failWith = message;
    },
  };
}

test("setClaudeToken stores ciphertext (not the token) and the last 4 chars", async () => {
  const f = fakeDb();
  await setClaudeToken("owner-1", "sk-ant-oat01-abcdEFGH", f.db);

  const stored = f.lastUpsert()!;
  assert.equal(stored.owner_id, "owner-1");
  assert.equal(stored.token_last4, "EFGH");
  assert.notEqual(stored.token_ciphertext, "sk-ant-oat01-abcdEFGH");
  assert.match(String(stored.token_ciphertext), /^v1:/);
});

test("getClaudeToken decrypts the stored token round-trip", async () => {
  const f = fakeDb();
  await setClaudeToken("owner-1", "the-real-token-value-123", f.db);
  assert.equal(await getClaudeToken("owner-1", f.db), "the-real-token-value-123");
});

test("getClaudeToken returns null when the owner has no token", async () => {
  const f = fakeDb();
  assert.equal(await getClaudeToken("nobody", f.db), null);
});

test("getClaudeTokenMeta reports presence and last-4 without the token", async () => {
  const f = fakeDb();
  await setClaudeToken("owner-1", "another-token-value-9999", f.db);

  assert.deepEqual(await getClaudeTokenMeta("owner-1", f.db), {
    connected: true,
    last4: "9999",
  });
  assert.deepEqual(await getClaudeTokenMeta("nobody", f.db), {
    connected: false,
    last4: null,
  });
});

test("deleteClaudeToken removes the row", async () => {
  const f = fakeDb();
  await setClaudeToken("owner-1", "delete-me-token-value-000", f.db);
  await deleteClaudeToken("owner-1", f.db);
  assert.equal(await getClaudeToken("owner-1", f.db), null);
});

test("surfaces database errors instead of silently succeeding", async () => {
  const f = fakeDb();
  f.fail("boom");
  await assert.rejects(() => setClaudeToken("owner-1", "token-value-here-1234", f.db), /boom/);
  await assert.rejects(() => getClaudeToken("owner-1", f.db), /boom/);
});
