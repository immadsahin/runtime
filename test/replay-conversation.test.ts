import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseConversation } from "@/lib/runtime/replay/conversation";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../lib/runtime/replay/conversation.fixtures.json", import.meta.url),
    ),
    "utf8",
  ),
) as { lines: string[]; events: unknown[] };

test("parseConversation matches the shared Go/TS golden fixture", () => {
  const events = parseConversation(fixture.lines.join("\n"));
  assert.deepEqual(events, fixture.events);
});

test("parseConversation tolerates malformed, empty, and app-internal records", () => {
  const jsonl = [
    "not json",
    "",
    "   ",
    '{"type":"system","uuid":"s","message":{"role":"user","content":[]}}',
    '{"type":"assistant","uuid":"u","message":null}',
    '{"type":"assistant","uuid":"ok","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ].join("\n");
  const events = parseConversation(jsonl);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    t: "message",
    uuid: "ok",
    parentUuid: null,
    role: "assistant",
    timestamp: "t",
    content: [{ type: "text", text: "hi" }],
  });
});

test("parseConversation captures the assistant model and omits it on user turns", () => {
  const jsonl = [
    '{"type":"assistant","uuid":"a","parentUuid":null,"timestamp":"t","message":{"role":"assistant","model":"claude-opus-4-5-20250115","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"user","uuid":"u","parentUuid":"a","timestamp":"t","message":{"role":"user","content":"yo"}}',
  ].join("\n");
  const [assistant, user] = parseConversation(jsonl) as { model?: string }[];
  assert.equal(assistant.model, "claude-opus-4-5-20250115");
  // Mirrors the Go omitempty: no model key on a user turn (not `undefined`).
  assert.ok(!("model" in user), "user turn should carry no model key");
});

test("parseConversation drops empty/absent protocol fields like the Go omitempty marshaling", () => {
  const jsonl =
    '{"type":"assistant","uuid":"u","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"","id":"","extra":"ignored"}]}}';
  const [event] = parseConversation(jsonl);
  // `text` and `id` are empty -> dropped; `extra` is not a protocol key -> dropped.
  assert.deepEqual((event as { content: unknown[] }).content, [{ type: "text" }]);
});
