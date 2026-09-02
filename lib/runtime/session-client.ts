/**
 * Browser-safe client for one Workspace Session.
 *
 * This module NEVER imports server-only code (runtime-token, env, secrets). It
 * only knows how to speak the frozen wire protocol given a URL that was minted
 * server-side by /api/workspaces/[id]/session.
 *
 * Every incoming frame is validated against the zod schemas in
 * `agent-protocol.ts` — if the agent ever sends a shape the browser doesn't
 * know, we surface it as an error instead of silently rendering garbage.
 *
 * See docs/architecture/session-contract.md.
 */

import type { Terminal } from "@xterm/xterm";

import {
  AgentEvent,
  PtyServerMessage,
  type PtyClientMessage,
} from "@/lib/runtime/agent-protocol";

export type TerminalAttachment = {
  /** Close the WebSocket and detach input listeners; safe to call twice. */
  dispose: () => void;
  /** Send a client frame (input/resize/ping); returns true if the socket is open. */
  send: (msg: PtyClientMessage) => boolean;
};

export type TerminalAttachOptions = {
  /** Called every time the agent's role frame changes writer status. */
  onRole?: (writer: boolean) => void;
  /** Called on `exit` (Claude/PTY died); UI should offer resume. */
  onExit?: (code: number) => void;
  /** Called on WS close for any reason — the hook uses this to trigger reconnect. */
  onClose?: (event: CloseEvent) => void;
  /** Called on an unexpected wire error (schema mismatch, decode failure, …). */
  onError?: (error: Error) => void;
};

/**
 * Attach an xterm.js instance to the PTY WebSocket.
 *
 * The xterm instance is caller-owned and NOT disposed on WS close — the caller
 * (usually a React hook) reuses it across reconnects so scrollback survives
 * the 5-minute token refresh. Only the WebSocket is disposed here.
 */
export function openTerminal(
  ptyUrl: string,
  terminal: Terminal,
  options: TerminalAttachOptions = {},
): TerminalAttachment {
  const ws = new WebSocket(ptyUrl);
  ws.binaryType = "arraybuffer";

  let disposed = false;
  const dataDisposable = terminal.onData((data) => {
    send({ t: "input", data });
  });
  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    send({ t: "resize", cols, rows });
  });

  ws.addEventListener("open", () => {
    // Sync initial size so the PTY matches the browser's xterm before any input.
    send({ t: "resize", cols: terminal.cols, rows: terminal.rows });
  });

  ws.addEventListener("message", (event) => {
    const parsed = parseServerFrame(event.data);
    if (!parsed) {
      options.onError?.(new Error("Invalid PTY frame from agent"));
      return;
    }
    switch (parsed.t) {
      case "output":
        terminal.write(parsed.data);
        break;
      case "role":
        options.onRole?.(parsed.writer);
        break;
      case "exit":
        options.onExit?.(parsed.code);
        break;
      case "pong":
        break;
    }
  });

  ws.addEventListener("close", (event) => {
    dispose();
    options.onClose?.(event);
  });

  ws.addEventListener("error", () => {
    // Browser fires 'error' without detail before 'close'; surface as needed.
    options.onError?.(new Error("PTY WebSocket error"));
  });

  function send(msg: PtyClientMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    dataDisposable.dispose();
    resizeDisposable.dispose();
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  }

  return { dispose, send };
}

function parseServerFrame(data: unknown) {
  const text = typeof data === "string" ? data : null;
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PtyServerMessage.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Conversation event stream (SSE). Parallel to openTerminal: caller owns the
// URL freshness (via useSessionAttachment) and passes lastEventId on
// programmatic reconnects. The browser also auto-reconnects EventSource and
// resends `Last-Event-ID` as a header, so the agent handles both.
// ---------------------------------------------------------------------------

export type EventSubscription = {
  /** Close the EventSource; safe to call twice. */
  dispose: () => void;
  /** The last event ID observed (JSONL byte offset), or null if none yet. */
  lastEventId: () => string | null;
};

export type EventSubscribeOptions = {
  /** Cursor to resume from; if set, appended as `?lastEventId=<id>`. */
  lastEventId?: string | null;
  /** Called on browser-detected connection loss; hook triggers URL refresh. */
  onClose?: () => void;
  /** Schema-mismatch or transport error, not lifecycle. */
  onError?: (error: Error) => void;
};

/**
 * Subscribe to the Workspace Session's AgentEvent stream. Every incoming
 * frame is validated against the frozen `AgentEvent` union; unknown shapes
 * are surfaced as errors so the Timeline never renders garbage.
 */
export function subscribeEvents(
  eventsUrl: string,
  onEvent: (event: AgentEvent, id: string) => void,
  options: EventSubscribeOptions = {},
): EventSubscription {
  const url =
    options.lastEventId != null && options.lastEventId !== ""
      ? appendQuery(eventsUrl, "lastEventId", options.lastEventId)
      : eventsUrl;

  const source = new EventSource(url);
  let disposed = false;
  let lastId: string | null = options.lastEventId ?? null;

  source.addEventListener("message", (raw) => {
    const messageEvent = raw as MessageEvent<string>;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(messageEvent.data);
    } catch {
      options.onError?.(new Error("Malformed SSE frame payload"));
      return;
    }
    const parsed = AgentEvent.safeParse(parsedJson);
    if (!parsed.success) {
      options.onError?.(new Error("SSE frame did not match AgentEvent schema"));
      return;
    }
    if (messageEvent.lastEventId) {
      lastId = messageEvent.lastEventId;
    }
    onEvent(parsed.data, messageEvent.lastEventId ?? "");
  });

  source.addEventListener("error", () => {
    // EventSource fires 'error' on transient blips (readyState === CONNECTING,
    // where it auto-reconnects with Last-Event-ID) AND on terminal failures
    // (readyState === CLOSED). Only a CLOSED source is a real loss that needs a
    // fresh /session; tearing down on every transient error spun the shared
    // attachment in a ~2s refetch loop that starved the conversation stream.
    if (source.readyState !== EventSource.CLOSED) return;
    dispose();
    options.onClose?.();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      source.close();
    } catch {
      // Already closed.
    }
  }

  return { dispose, lastEventId: () => lastId };
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
