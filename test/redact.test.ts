import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRedactor } from "@/lib/runtime/redact";

test("makeRedactor replaces every secret with ***", () => {
  const redact = makeRedactor(["sk-secret", "ghp_token"]);
  assert.equal(redact("using sk-secret and ghp_token now"), "using *** and *** now");
});

test("makeRedactor ignores empty/undefined/null secrets", () => {
  const redact = makeRedactor(["", undefined, null]);
  assert.equal(redact("nothing to redact"), "nothing to redact");
});

test("makeRedactor redacts repeated occurrences", () => {
  const redact = makeRedactor(["X"]);
  assert.equal(redact("XaXbX"), "***a***b***");
});
