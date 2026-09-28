"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";
import { reconnectPlan } from "@/lib/runtime/reconnect";
import { subscribeEventsWs } from "@/lib/runtime/session-client";

import type { SessionAttachment } from "./use-session-attachment";

export type ConversationStreamState = {
  events: AgentEvent[];
  status: "loading" | "connecting" | "connected" | "disconnected" | "error";
  error: string | null;
  /** Force a full URL refresh + re-subscribe. Preserves the resume cursor. */
  refresh: () => void;
};

// Reconnect backoff lives in lib/runtime/reconnect (pure + unit-tested). Unlike
// EventSource (which absorbs blips with its own retry), a WS close here triggers
// a full reconnect — refetch URLs + a fresh token + a new socket — so the policy
// backs off exponentially and gives up after a bounded number of consecutive
// failures rather than hammering /session against a genuinely-down endpoint.

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
          const plan = reconnectPlan(attempt);
          if (!plan.retry) {
            // Automatic retry is exhausted (e.g. endpoint permanently down). Not
            // a dead end: the visibility/focus/online effect re-arms this when
            // the app becomes active again, and the user can refresh to retry.
            dispatch({
              kind: "error",
              message: "Lost the conversation stream. Refresh to reconnect.",
            });
            return;
          }
          // Back off, then let the shared attachment refetch URLs (coalescing
          // simultaneous terminal + events closes into one refresh).
          reconnectTimerRef.current = setTimeout(() => {
            if (active) reconnect();
          }, plan.delayMs);
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

  // Idle recovery. A backgrounded/hidden webview (the desktop app hides to the
  // tray) can have its socket suspended, so every backoff retry fails and we
  // land in the closed/give-up state until the user does something — the "error
  // when idle, works the moment I send a message" symptom. When the app becomes
  // visible, regains focus, or the network returns, reset the retry budget and
  // reconnect at once so the stream is healthy again before the next prompt,
  // instead of waiting for a POST to incidentally revive it.
  //
  // Re-arm only for a transport loss: `ws.closed` (the socket dropped) or an
  // attachment "error" (a /session refetch that failed, e.g. offline, so a
  // returning network can retry it). A protocol error on a still-open socket
  // (`ws.error` while `ws.closed` is false) must NOT trigger this — reconnecting
  // would tear down a healthy socket on the next focus. reconnect() just
  // schedules refresh(), so it is safe to arm during "error" as well as
  // "attached".
  const transportLost = ws.closed || attachmentStatus === "error";
  useEffect(() => {
    if (attachmentStatus !== "attached" && attachmentStatus !== "error") return;
    if (!transportLost) return;
    const rearm = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      reconnectAttemptsRef.current = 0;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnect();
    };
    document.addEventListener("visibilitychange", rearm);
    window.addEventListener("focus", rearm);
    window.addEventListener("online", rearm);
    return () => {
      document.removeEventListener("visibilitychange", rearm);
      window.removeEventListener("focus", rearm);
      window.removeEventListener("online", rearm);
    };
  }, [attachmentStatus, transportLost, reconnect]);

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
