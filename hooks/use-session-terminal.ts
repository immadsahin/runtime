"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { openTerminal } from "@/lib/runtime/session-client";

import { useSessionAttachment } from "./use-session-attachment";

export type SessionTerminalState = {
  status:
    | "loading"
    | "connecting"
    | "connected"
    | "disconnected"
    | "exited"
    | "error";
  role: "writer" | "reader" | "unknown";
  error: string | null;
  exitCode: number | null;
  /** Force a full URL re-fetch + reattach (test knob for the 5-min TTL flow). */
  refresh: () => void;
};

type WsPhase = "idle" | "open" | "closed";

/**
 * Mounts an xterm.js instance into the container and keeps it attached to the
 * workspace's PTY across reconnects. The xterm instance lives for the lifetime
 * of the container; only the WebSocket is torn down and rebuilt on token
 * refresh or transient disconnect. This is what makes the 5-min token TTL
 * invisible to the user.
 */
export function useSessionTerminal(
  workspaceId: string,
  containerRef: RefObject<HTMLDivElement | null>,
): SessionTerminalState {
  const attachment = useSessionAttachment(workspaceId);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [role, setRole] = useState<SessionTerminalState["role"]>("unknown");
  const [wsError, setWsError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [wsPhase, setWsPhase] = useState<WsPhase>("idle");

  // Own the xterm instance — it survives WS reconnects so local scrollback
  // persists across every 5-min token refresh.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      theme: { background: "#0b0b0b" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    terminalRef.current = term;
    fitRef.current = fit;

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // Container hidden/unmounted; ignore.
      }
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(onResize);
    observer?.observe(container);

    return () => {
      observer?.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [containerRef]);

  // Reattach the WebSocket whenever fresh URLs arrive. Do NOT rebuild xterm.
  useEffect(() => {
    const url = attachment.urls?.ptyUrl;
    const term = terminalRef.current;
    if (!url || !term || attachment.status !== "attached") return;

    let reattachTimer: ReturnType<typeof setTimeout> | null = null;
    setWsError(null);

    const handle = openTerminal(url, term, {
      onRole: (writer) => setRole(writer ? "writer" : "reader"),
      onExit: (code) => setExitCode(code),
      onClose: () => {
        setWsPhase("closed");
        // Refresh URLs + reattach after a short backoff. Skip if the session
        // already ended cleanly — an exited PTY won't come back on its own.
        reattachTimer = setTimeout(() => attachment.refresh(), 500);
      },
      onError: (err) => setWsError(err.message),
    });
    setWsPhase("open");

    return () => {
      if (reattachTimer) clearTimeout(reattachTimer);
      handle.dispose();
    };
    // attachId changes on every successful refresh -> reattach.
  }, [attachment.attachId, attachment.status, attachment.urls?.ptyUrl, attachment]);

  const status = useMemo<SessionTerminalState["status"]>(() => {
    if (exitCode !== null) return "exited";
    if (attachment.status === "loading") return "loading";
    if (attachment.status === "error") return "error";
    if (wsPhase === "open") return "connected";
    if (wsPhase === "closed") return "disconnected";
    return "connecting";
  }, [attachment.status, wsPhase, exitCode]);

  const error = wsError ?? attachment.error;

  return { status, role, error, exitCode, refresh: attachment.refresh };
}
