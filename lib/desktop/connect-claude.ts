import { isDesktopApp } from "@/lib/is-desktop";

/**
 * Desktop-only "Connect Claude" bridge.
 *
 * The hosted web UI runs inside the Tauri shell, which exposes the native
 * `connect_claude` command over IPC (enabled for this origin in the shell's
 * capabilities). That command runs `claude setup-token` on the user's machine —
 * opening the browser to log in if needed — and returns the minted token. The
 * web app never sees the local CLI; it only receives the resulting token and
 * hands it to the server for encrypted storage.
 */

/** The slice of the injected Tauri global we rely on (withGlobalTauri: true). */
type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
};

/**
 * Extract a Claude token from the native command's result. The command returns
 * just the token, but we parse defensively in case any surrounding output slips
 * through. Returns null when nothing token-shaped is present.
 */
export function parseSetupToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Prefer an explicit Anthropic token anywhere in the output.
  const match = trimmed.match(/sk-ant-[A-Za-z0-9_-]{10,}/);
  if (match) return match[0];

  // Otherwise accept a single opaque token line (no whitespace, plausible size).
  if (!/\s/.test(trimmed) && trimmed.length >= 20 && trimmed.length <= 500) {
    return trimmed;
  }
  return null;
}

/** Human-readable message for a native-side error code. */
function messageForError(code: string): string {
  switch (code) {
    case "claude-cli-not-found":
      return "Claude Code isn't installed on this machine. Install it, then try again.";
    case "claude-setup-token-failed":
    case "no-token-in-output":
      return "Couldn't get a token from Claude. Make sure you can run `claude setup-token`.";
    default:
      return code || "Connecting to Claude failed.";
  }
}

/**
 * Run the native connect flow and return the minted token. Throws with a
 * user-facing message on any failure (not desktop, bridge missing, CLI error).
 */
export async function connectClaudeViaDesktop(): Promise<string> {
  if (!isDesktopApp()) {
    throw new Error("Connecting Claude is only available in the desktop app.");
  }
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) {
    throw new Error("The desktop bridge is unavailable. Restart the app and try again.");
  }

  let raw: unknown;
  try {
    raw = await invoke("connect_claude");
  } catch (error) {
    throw new Error(messageForError(error instanceof Error ? error.message : String(error)));
  }

  const token = parseSetupToken(raw);
  if (!token) {
    throw new Error(
      "Didn't receive a Claude token. Make sure Claude Code is installed and you're logged in.",
    );
  }
  return token;
}
