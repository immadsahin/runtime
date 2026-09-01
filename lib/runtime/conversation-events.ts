/**
 * Pure event-log helpers for the Conversation projection. Kept in a separate
 * module (no React, no xterm, no browser globals) so it can be unit-tested in
 * Node without dragging the client-only session-client / hook code along.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";

/**
 * Append one event to the Conversation log, honoring the invariants from
 * docs/architecture/session-contract.md:
 *
 *   - state events are not resumable; each fresh connect re-emits state, so
 *     we collapse to at-most-one state entry (the newest).
 *   - message events UPSERT by their `uuid`: the agent streams a turn as the
 *     same message re-emitted as it grows (a new SSE id each time), so we
 *     replace the existing entry in place rather than append every partial.
 *   - usage/other events carry a stable SSE id (JSONL byte offset); dedup by id
 *     defensively against a client-side double-subscribe.
 */
export function appendEvent(
  prev: AgentEvent[],
  event: AgentEvent,
  id: string,
  seenIds: Set<string>,
): AgentEvent[] {
  if (event.t === "state") {
    const withoutState = prev.filter((e) => e.t !== "state");
    return [...withoutState, event];
  }
  if (event.t === "message") {
    // Streaming: the same uuid arrives repeatedly, growing. Replace in place so
    // the message renders once and updates, instead of stacking partials.
    const idx = prev.findIndex((e) => e.t === "message" && e.uuid === event.uuid);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = event;
      return next;
    }
    return [...prev, event];
  }
  if (id && seenIds.has(id)) return prev;
  if (id) seenIds.add(id);
  return [...prev, event];
}
