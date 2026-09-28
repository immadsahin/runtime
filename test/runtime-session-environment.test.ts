import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { runtimeSessionEnvironment } from "@/lib/runtime/ensure-runtime-computer";

const CLAUDE_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CLAUDE_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of CLAUDE_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("no override: passes through the platform credentials that are set", () => {
  process.env.ANTHROPIC_API_KEY = "platform-api-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "platform-oauth";
  delete process.env.CODEX_API_KEY;

  assert.deepEqual(runtimeSessionEnvironment(), {
    ANTHROPIC_API_KEY: "platform-api-key",
    CLAUDE_CODE_OAUTH_TOKEN: "platform-oauth",
  });
});

test("user token replaces platform Claude creds and drops the API key", () => {
  process.env.ANTHROPIC_API_KEY = "platform-api-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "platform-oauth";
  process.env.CODEX_API_KEY = "platform-codex";

  const env = runtimeSessionEnvironment({ claudeCodeOAuthToken: "user-token" });

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "user-token");
  assert.equal(env.ANTHROPIC_API_KEY, undefined); // never bill the platform key
  assert.equal(env.CODEX_API_KEY, "platform-codex"); // Codex is unaffected
});

test("blank / whitespace / null override falls back to the platform creds", () => {
  process.env.ANTHROPIC_API_KEY = "platform-api-key";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CODEX_API_KEY;

  for (const value of ["", "   ", null, undefined]) {
    assert.deepEqual(
      runtimeSessionEnvironment({ claudeCodeOAuthToken: value }),
      { ANTHROPIC_API_KEY: "platform-api-key" },
    );
  }
});

test("trims the user token before seeding it", () => {
  const env = runtimeSessionEnvironment({ claudeCodeOAuthToken: "  user-token  " });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "user-token");
});
