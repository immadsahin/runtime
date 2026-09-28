import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";

const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
});

test("round-trips plaintext", () => {
  const secret = "sk-ant-oat01-example-token-value";
  assert.equal(decryptSecret(encryptSecret(secret)), secret);
});

test("round-trips unicode and empty strings", () => {
  for (const secret of ["", "  spaces  ", "clé-🔐-tokén"]) {
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
  }
});

test("produces a version-tagged v1 payload distinct from the plaintext", () => {
  const payload = encryptSecret("super-secret-token-value");
  assert.match(payload, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!payload.includes("super-secret-token-value"));
});

test("uses a fresh IV so the same plaintext encrypts differently each time", () => {
  assert.notEqual(encryptSecret("same"), encryptSecret("same"));
});

test("rejects a tampered ciphertext (GCM authentication)", () => {
  const [v, iv, tag, ct] = encryptSecret("token").split(":");
  const flipped = Buffer.from(ct, "base64");
  flipped[0] ^= 0xff;
  const tampered = [v, iv, tag, flipped.toString("base64")].join(":");
  assert.throws(() => decryptSecret(tampered));
});

test("rejects a malformed or unknown-version payload", () => {
  assert.throws(() => decryptSecret("not-a-payload"));
  assert.throws(() => decryptSecret("v2:a:b:c"));
});

test("cannot decrypt with a different key", () => {
  const payload = encryptSecret("token");
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.throws(() => decryptSecret(payload));
});

test("rejects a key that is not 32 bytes", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(16).toString("base64");
  assert.throws(() => encryptSecret("token"), /32 bytes/);
});
