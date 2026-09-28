import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { requireEnv } from "@/lib/env";

/**
 * Symmetric encryption for secrets stored at rest (per-user Claude tokens).
 *
 * AES-256-GCM with a single application key read from `CREDENTIAL_ENCRYPTION_KEY`
 * (32 raw bytes, base64-encoded). GCM is authenticated: any tampering with the
 * IV, tag, or ciphertext makes {@link decryptSecret} throw rather than return
 * corrupted plaintext.
 *
 * The payload is a self-describing, version-tagged string so the key/algorithm
 * can be rotated later without ambiguity:
 *
 *   v1:<base64 iv>:<base64 tag>:<base64 ciphertext>
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const raw = requireEnv("CREDENTIAL_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}

/** Encrypt UTF-8 plaintext into a version-tagged, authenticated payload. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a payload produced by {@link encryptSecret}. Throws on an unknown
 * version, a malformed payload, or any authentication failure (wrong key or
 * tampered bytes) — callers must treat a throw as "unusable credential".
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed or unsupported secret payload.");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Malformed secret payload.");
  }

  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}
