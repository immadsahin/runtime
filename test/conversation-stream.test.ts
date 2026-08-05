import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentEvent,
  ConversationMessage,
  WorkspaceStateChanged,
} from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";

const state = (s: WorkspaceStateChanged["state"]): AgentEvent => ({
  t: "state",
  workspaceId: "w",
  state: s,
});

const message = (uuid: string, text: string): ConversationMessage => ({
  t: "message",
  uuid,
  parentUuid: null,
  role: "assistant",
  timestamp: "t",
  content: [{ type: "text", text }],
});

test("appendEvent dedupes message frames by id", () => {
  const seen = new Set<string>();
  let events: AgentEvent[] = [];
  events = appendEvent(events, message("m1", "hi"), "42", seen);
  events = appendEvent(events, message("m1", "hi"), "42", seen); // dup
  events = appendEvent(events, message("m2", "yo"), "58", seen);
  assert.equal(events.length, 2);
  assert.equal((events[0] as ConversationMessage).uuid, "m1");
  assert.equal((events[1] as ConversationMessage).uuid, "m2");
});

test("appendEvent collapses state — only one lives at a time", () => {
  const seen = new Set<string>();
  let events: AgentEvent[] = [];
  events = appendEvent(events, state("starting"), "0", seen);
  events = appendEvent(events, message("m1", "hi"), "42", seen);
  events = appendEvent(events, state("running"), "0", seen); // supersedes
  const states = events.filter((e) => e.t === "state") as WorkspaceStateChanged[];
  assert.equal(states.length, 1, "at most one state entry");
  assert.equal(states[0].state, "running");
  // Message survives across state replacements.
  const messages = events.filter((e) => e.t === "message");
  assert.equal(messages.length, 1);
});

test("appendEvent tolerates missing id", () => {
  const seen = new Set<string>();
  const events = appendEvent([], message("m1", "hi"), "", seen);
  assert.equal(events.length, 1);
});
