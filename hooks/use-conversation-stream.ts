"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";
import { subscribeEvents } from "@/lib/runtime/session-client";

import { useSessionAttachment } from "./use-session-attachment";

export type ConversationStreamState = {
  events: AgentEvent[];
  status: "loading" | "connecting" | "connected" | "disconnected" | "error";
  error: string | null;
  /** Force a full URL refresh + re-subscribe. Preserves the resume cursor. */
  refresh: () => void;
};

// A single {wsError, wsClosed} slice: reducer keeps effect body free of
// setState, and both signals update from the same subscribe callbacks.
type WsStatus = { error: string | null; closed: boolean; connectAttempt: number };
type WsAction =
  | { kind: "frame-received" }
  | { kind: "closed" }
  | { kind: "error"; message: string }
  | { kind: "reset" };

function wsReducer(state: WsStatus, action: WsAction): WsStatus {
  switch (action.kind) {
    case "frame-received":
      // First frame after connect implicitly means we're open again.
      return { error: null, closed: false, connectAttempt: state.connectAttempt };
    case "closed":
      return { ...state, closed: true };
    case "error":
      return { ...state, error: action.message };
    case "reset":
      return { error: null, closed: false, connectAttempt: state.connectAttempt + 1 };
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
export function useConversationStream(workspaceId: string): ConversationStreamState {
  const attachment = useSessionAttachment(workspaceId);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [ws, dispatch] = useReducerState();
  const lastEventIdRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const url = attachment.urls?.eventsUrl;
    if (!url || attachment.status !== "attached") return;

    let reattachTimer: ReturnType<typeof setTimeout> | null = null;

    const sub = subscribeEvents(
      url,
      (event, id) => {
        // Message/usage events are deduplicated by SSE id. State events use a
        // synthetic id ("0"): they aren't resumable and are re-observed on
        // fresh connects, so we replace the newest state entry instead.
        setEvents((prev) => appendEvent(prev, event, id, seenIdsRef.current));
        if (id && id !== "0") lastEventIdRef.current = id;
        dispatch({ kind: "frame-received" });
      },
      {
        lastEventId: lastEventIdRef.current,
        onClose: () => {
          dispatch({ kind: "closed" });
          reattachTimer = setTimeout(() => attachment.refresh(), 500);
        },
        onError: (err) => dispatch({ kind: "error", message: err.message }),
      },
    );

    return () => {
      if (reattachTimer) clearTimeout(reattachTimer);
      sub.dispose();
    };
  }, [attachment.attachId, attachment.status, attachment.urls?.eventsUrl, attachment, dispatch]);

  const status = useMemo<ConversationStreamState["status"]>(() => {
    if (attachment.status === "loading") return "loading";
    if (attachment.status === "error") return "error";
    if (ws.error && ws.closed) return "error";
    if (ws.closed) return "disconnected";
    // We consider ourselves "connected" once at least one frame arrived (the
    // agent emits an initial state event on every fresh connect, so this
    // resolves within one round trip). Before that, we're still connecting.
    return events.length > 0 ? "connected" : "connecting";
  }, [attachment.status, ws.error, ws.closed, events.length]);

  return {
    events,
    status,
    error: ws.error ?? attachment.error,
    refresh: attachment.refresh,
  };
}

// Small helper to hide useReducer typing; keeps the hook readable.
function useReducerState() {
  const [state, setState] = useState<WsStatus>({
    error: null,
    closed: false,
    connectAttempt: 0,
  });
  const dispatch = useMemo(
    () => (action: WsAction) => setState((s) => wsReducer(s, action)),
    [],
  );
  return [state, dispatch] as const;
}

