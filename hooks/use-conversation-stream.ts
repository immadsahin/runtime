"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";
import { subscribeEventsWs } from "@/lib/runtime/session-client";

import type { SessionAttachment } from "./use-session-attachment";

export type ConversationStreamState = {
  events: AgentEvent[];
  status: "loading" | "connecting" | "connected" | "disconnected" | "error";
  error: string | null;
  /** Force a full URL refresh + re-subscribe. Preserves the resume cursor. */
  refresh: () => void;
};

// Reconnect backoff. Unlike EventSource (which absorbs blips with its own
// retry), a WS close here triggers a full reconnect — refetch URLs + a fresh
// token + a new socket. Without a cap that loops forever if the endpoint is
// down (e.g. an old agent that lacks /events-ws), hammering /session. So back
// off exponentially and give up after a bounded number of consecutive failures.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 6; // ~0.5,1,2,4,8,16s, then stop (~31s total)

// A single {error, closed} slice: reducer keeps effect body free of setState,
// and both signals update from the same subscribe callbacks.
type WsStatus = { error: string | null; closed: boolean };
type WsAction =
  | { kind: "frame-received" }
  | { kind: "closed" }
  | { kind: "error"; message: string };

function wsReducer(state: WsStatus, action: WsAction): WsStatus {
  switch (action.kind) {
    case "frame-received":
      // First frame after connect implicitly means we're open again.
      return { error: null, closed: false };
    case "closed":
      return { ...state, closed: true };
    case "error":
      return { ...state, error: action.message };
  }
}

/**
 * Subscribe to the Workspace Session's AgentEvent stream. State events (which
 * aren't resumable) are re-observed on every fresh connect and de-duplicated
 * so status stays consistent; message/usage events are keyed by the SSE `id`
 * (JSONL byte offset), so a duplicate delivery — which the resume protocol
 * makes impossible in the happy path, but defensive dedup guards against
 * client-side races on double-subscribe — never renders twice.
 *
 * The hook owns the `lastEventId` cursor across reconnects; the useSessionAttachment
 * hook re-fetches URLs, but the cursor survives so subscribeEvents starts
 * from exactly where we left off.
 */
export function useConversationStream(attachment: SessionAttachment): ConversationStreamState {
  const {
    urls,
    status: attachmentStatus,
    error: attachmentError,
    attachId,
    reconnect,
    refresh,
  } = attachment;
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [ws, dispatch] = useReducerState();
  const lastEventIdRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Consecutive failed reconnects (reset by any received frame). A ref, not
  // reducer state, so the onClose closure reads the live count, not a stale one.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const url = urls?.eventsUrl;
    if (!url || attachmentStatus !== "attached") return;

    let active = true;

    const sub = subscribeEventsWs(
      url,
      (event, id) => {
        // Message/usage events are deduplicated by SSE id. State events use a
        // synthetic id ("0"): they aren't resumable and are re-observed on
        // fresh connects, so we replace the newest state entry instead.
        setEvents((prev) => appendEvent(prev, event, id, seenIdsRef.current));
        if (id && id !== "0") lastEventIdRef.current = id;
        // A live frame means this connection is healthy: clear the backoff.
        reconnectAttemptsRef.current = 0;
        dispatch({ kind: "frame-received" });
      },
      {
        lastEventId: lastEventIdRef.current,
        onClose: () => {
          if (!active) return;
          dispatch({ kind: "closed" });
          const attempt = (reconnectAttemptsRef.current += 1);
          if (attempt > MAX_RECONNECT_ATTEMPTS) {
            // Give up rather than loop forever (e.g. endpoint permanently down);
            // the user can refresh to retry.
            dispatch({
              kind: "error",
              message: "Lost the conversation stream. Refresh to reconnect.",
            });
            return;
          }
          // Back off, then let the shared attachment refetch URLs (coalescing
          // simultaneous terminal + events closes into one refresh).
          const delay = Math.min(
            RECONNECT_BASE_MS * 2 ** (attempt - 1),
            RECONNECT_MAX_MS,
          );
          reconnectTimerRef.current = setTimeout(() => {
            if (active) reconnect();
          }, delay);
        },
        onError: (err) => dispatch({ kind: "error", message: err.message }),
      },
    );

    return () => {
      active = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      sub.dispose();
    };
  }, [attachId, attachmentStatus, dispatch, reconnect, urls?.eventsUrl]);

  const status = useMemo<ConversationStreamState["status"]>(() => {
    if (attachmentStatus === "loading") return "loading";
    if (attachmentStatus === "error") return "error";
    if (ws.error && ws.closed) return "error";
    if (ws.closed) return "disconnected";
    // We consider ourselves "connected" once at least one frame arrived (the
    // agent emits an initial state event on every fresh connect, so this
    // resolves within one round trip). Before that, we're still connecting.
    return events.length > 0 ? "connected" : "connecting";
  }, [attachmentStatus, ws.error, ws.closed, events.length]);

  return {
    events,
    status,
    error: ws.error ?? attachmentError,
    refresh,
  };
}

// Small helper to hide useReducer typing; keeps the hook readable.
function useReducerState() {
  const [state, setState] = useState<WsStatus>({
    error: null,
    closed: false,
  });
  const dispatch = useMemo(
    () => (action: WsAction) => setState((s) => wsReducer(s, action)),
    [],
  );
  return [state, dispatch] as const;
}
