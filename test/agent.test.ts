import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentCommand,
  agentCredentialMessage,
  agentJobEnvironment,
  agentJobSecrets,
  isJobAgent,
} from "@/lib/runtime/agent";
import { MODAL_IMAGE_COMMANDS } from "@/lib/runtime/modal-provider";

const credentialKeys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY"] as const;

function withCredentials(
  values: Partial<Record<(typeof credentialKeys)[number], string>>,
  run: () => void,
): void {
  const previous = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of credentialKeys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    run();
  } finally {
    for (const key of credentialKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("agent parser accepts only supported persisted values", () => {
  assert.equal(isJobAgent("claude"), true);
  assert.equal(isJobAgent("codex"), true);
  assert.equal(isJobAgent("openai"), false);
  assert.equal(isJobAgent(undefined), false);
});

test("Codex and Claude commands retain their explicit non-interactive policies", () => {
  assert.equal(
    agentCommand("codex", { prompt: "fix 'the bug'" }),
    "codex exec --sandbox workspace-write --ask-for-approval never 'fix '\\''the bug'\\'''",
  );
  assert.match(agentCommand("claude", { prompt: "fix it" }), /^claude -p 'fix it'/);
  assert.match(agentCommand("claude", { prompt: "fix it", resumeSessionId: "session-1" }), /--resume 'session-1'/);
});

test("selected agent receives and redacts only its own credentials", () => {
  withCredentials(
    {
      ANTHROPIC_API_KEY: "anthropic-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
      CODEX_API_KEY: "codex-secret",
    },
    () => {
      assert.deepEqual(agentJobEnvironment("claude"), {
        ANTHROPIC_API_KEY: "anthropic-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
      });
      assert.deepEqual(agentJobEnvironment("codex"), { CODEX_API_KEY: "codex-secret" });
      assert.deepEqual(agentJobSecrets("codex"), ["codex-secret"]);
    },
  );
});

test("Codex reports its credential requirement and is built into the Modal image", () => {
  assert.equal(agentCredentialMessage("codex"), "Set CODEX_API_KEY to run Codex.");
  assert.match(MODAL_IMAGE_COMMANDS.join("\n"), /@anthropic-ai\/claude-code/);
  assert.match(MODAL_IMAGE_COMMANDS.join("\n"), /@openai\/codex/);
});
