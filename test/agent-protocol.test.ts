import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  PROTOCOL_SCHEMAS,
  type ProtocolSchemaName,
} from "@/lib/runtime/agent-protocol";

/**
 * The golden fixtures are the shared source of truth between this (zod) side and
 * the Go agent. Every fixture must validate against its named schema; this is
 * the TS half of the two-language drift guard.
 */
const fixtures = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "lib/runtime/agent-protocol.fixtures.json"),
    "utf8",
  ),
) as Record<string, unknown[]>;

test("every schema in the registry has at least one golden fixture", () => {
  for (const name of Object.keys(PROTOCOL_SCHEMAS)) {
    assert.ok(
      Array.isArray(fixtures[name]) && fixtures[name].length > 0,
      `missing fixtures for ${name}`,
    );
  }
});

test("every golden fixture validates against its schema", () => {
  for (const [name, examples] of Object.entries(fixtures)) {
    const schema = PROTOCOL_SCHEMAS[name as ProtocolSchemaName];
    assert.ok(schema, `no schema registered for fixture "${name}"`);
    for (const example of examples) {
      const result = schema.safeParse(example);
      assert.ok(
        result.success,
        `fixture ${name} failed: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
      );
    }
  }
});

test("schemas reject malformed messages", () => {
  assert.equal(
    PROTOCOL_SCHEMAS.PtyClientMessage.safeParse({ t: "nope" }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.RuntimeTokenClaims.safeParse({
      workspaceId: "ws-1",
      projectId: "p",
      computerId: "c",
      userId: "u",
      exp: -1,
    }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.ErrorResponse.safeParse({
      error: { code: "NOT_A_CODE", message: "x" },
    }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.SessionUrls.safeParse({ ptyUrl: "not-a-url" }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.SessionUrls.safeParse({}).success,
    false,
    "ptyUrl is required",
  );
});
