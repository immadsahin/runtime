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
 *   - message/usage events carry a stable SSE id (JSONL byte offset). The
 *     agent's seq-based resume guarantees zero duplicates in the happy path,
 *     but we still dedup defensively in case of a client-side double-subscribe.
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
  if (id && seenIds.has(id)) return prev;
  if (id) seenIds.add(id);
  return [...prev, event];
}
