"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SessionUrls } from "@/lib/runtime/agent-protocol";

/**
 * Owner of the Workspace Session's URL lifecycle: fetches
 * POST /api/workspaces/[id]/session, exposes the URLs to child projections,
 * and re-fetches on demand (reconnect / TTL refresh).
 *
 * `attachId` increments every time new URLs arrive. Child hooks watch it to
 * know when to reattach — they never fetch URLs themselves. This is the one
 * place URL freshness is decided; do not duplicate this logic per projection.
 */
export type SessionAttachmentStatus =
  | "idle"
  | "loading"
  | "attached"
  | "error";

export type SessionAttachment = {
  urls: SessionUrls | null;
  status: SessionAttachmentStatus;
  error: string | null;
  /** Increments every time `urls` changes (new fetch succeeded). */
  attachId: number;
  /** Fetch fresh URLs. Idempotent while a fetch is in flight. */
  refresh: () => void;
  /**
   * Ask the shared attachment owner to refresh after a transient transport
   * close. Calls made by the terminal and event projections are coalesced.
   */
  reconnect: () => void;
};

export function useSessionAttachment(workspaceId: string): SessionAttachment {
  const [urls, setUrls] = useState<SessionUrls | null>(null);
  const [status, setStatus] = useState<SessionAttachmentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [attachId, setAttachId] = useState(0);

  const inflight = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (inflight.current) return;
    const controller = new AbortController();
    inflight.current = controller;
    setStatus("loading");
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/session`, {
          method: "POST",
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(body?.error ?? `Session attach failed (${res.status})`);
        }
        const raw = (await res.json()) as unknown;
        const parsed = SessionUrls.safeParse(raw);
        if (!parsed.success) {
          throw new Error("Malformed session response from server");
        }
        setUrls(parsed.data);
        setAttachId((n) => n + 1);
        setStatus("attached");
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inflight.current = null;
      }
    })();
  }, [workspaceId]);

  const reconnect = useCallback(() => {
    // Both browser projections can notice the same network close. The
    // attachment, rather than either projection, owns the retry so that one
    // close produces one fresh pair of short-lived URLs.
    if (inflight.current || reconnectTimer.current) return;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      refresh();
    }, 500);
  }, [refresh]);

  useEffect(() => {
    refresh();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [refresh]);

  return { urls, status, error, attachId, refresh, reconnect };
}
