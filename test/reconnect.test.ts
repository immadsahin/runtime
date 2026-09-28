import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectPlan,
} from "@/lib/runtime/reconnect";

test("reconnectPlan backs off exponentially from the base delay", () => {
  assert.deepEqual(reconnectPlan(1), { retry: true, delayMs: RECONNECT_BASE_MS });
  assert.deepEqual(reconnectPlan(2), { retry: true, delayMs: RECONNECT_BASE_MS * 2 });
  assert.deepEqual(reconnectPlan(3), { retry: true, delayMs: RECONNECT_BASE_MS * 4 });
  assert.deepEqual(reconnectPlan(4), { retry: true, delayMs: RECONNECT_BASE_MS * 8 });
});

test("reconnectPlan pins late in-budget attempts to the delay ceiling", () => {
  // The raw exponential delay for the last in-budget attempt exceeds the cap,
  // so it must clamp to exactly RECONNECT_MAX_MS (the capping path is real).
  const raw = RECONNECT_BASE_MS * 2 ** (MAX_RECONNECT_ATTEMPTS - 1);
  assert.ok(raw > RECONNECT_MAX_MS, "cap is only meaningful if the raw delay exceeds it");
  assert.deepEqual(reconnectPlan(MAX_RECONNECT_ATTEMPTS), {
    retry: true,
    delayMs: RECONNECT_MAX_MS,
  });
});

test("reconnectPlan retries through the whole budget then gives up", () => {
  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
    assert.equal(reconnectPlan(attempt).retry, true, `attempt ${attempt} should retry`);
  }
  assert.deepEqual(reconnectPlan(MAX_RECONNECT_ATTEMPTS + 1), { retry: false });
  assert.deepEqual(reconnectPlan(MAX_RECONNECT_ATTEMPTS + 5), { retry: false });
});
