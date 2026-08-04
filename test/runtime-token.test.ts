import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mintRuntimeToken,
  verifyRuntimeToken,
} from "@/lib/runtime/runtime-token";

const secret = "per-computer-secret";
const identity = {
  workspaceId: "ws-1",
  projectId: "p-1",
  computerId: "c-1",
  userId: "u-1",
};

test("mint -> verify round-trips the claims", () => {
  const token = mintRuntimeToken(identity, secret);
  const claims = verifyRuntimeToken(token, secret);
  assert.equal(claims.workspaceId, "ws-1");
  assert.equal(claims.computerId, "c-1");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
});

test("verify rejects a tampered signature", () => {
  const token = mintRuntimeToken(identity, secret) + "x";
  assert.throws(() => verifyRuntimeToken(token, secret), /signature/);
});

test("verify rejects the wrong secret", () => {
  const token = mintRuntimeToken(identity, secret);
  assert.throws(() => verifyRuntimeToken(token, "other"), /signature/);
});

test("verify rejects an expired token", () => {
  const token = mintRuntimeToken(
    { ...identity, exp: Math.floor(Date.now() / 1000) - 1 },
    secret,
  );
  assert.throws(() => verifyRuntimeToken(token, secret), /expired/);
});

test("verify rejects a structurally malformed token", () => {
  assert.throws(() => verifyRuntimeToken("not-a-jwt", secret), /malformed/);
});
