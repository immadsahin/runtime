/**
 * True when the web app runs inside the Runtime desktop shell (Tauri).
 *
 * The desktop app injects `window.__RUNTIME_DESKTOP__ = true` before the page
 * loads. We use it to route GitHub OAuth through the system browser instead of
 * the embedded webview (which providers block or render poorly).
 */
export function isDesktopApp(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __RUNTIME_DESKTOP__?: boolean }).__RUNTIME_DESKTOP__ === true
  );
}
