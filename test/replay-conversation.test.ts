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

test("parseConversation drops empty/absent protocol fields like the Go omitempty marshaling", () => {
  const jsonl =
    '{"type":"assistant","uuid":"u","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"","id":"","extra":"ignored"}]}}';
  const [event] = parseConversation(jsonl);
  // `text` and `id` are empty -> dropped; `extra` is not a protocol key -> dropped.
  assert.deepEqual((event as { content: unknown[] }).content, [{ type: "text" }]);
});
