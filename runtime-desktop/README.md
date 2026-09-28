# Runtime Desktop

A lightweight native macOS shell for [Runtime](https://runtime.zerotrail.ai),
built with [Tauri v2](https://tauri.app). Conductor-style: a real app window
plus a menu-bar (tray) presence, wrapping the hosted Runtime web UI.

It stays thin on purpose. The web UI already opens the terminal WebSocket
**directly to the Daytona box**, so the native layer only provides the shell and
OS niceties — no duplicated frontend, always up to date with the deploy.

## What it does today

- **Main window** loads `https://runtime.zerotrail.ai` (system WebView — no
  bundled Chromium, so the app is a few MB).
- **Tray icon + menu**: Show Runtime · New Workspace · Reload · Quit.
- **Left-click the tray** toggles the window.
- **Hide-to-tray**: closing the window keeps the app (and your session)
  running in the tray; use *Quit Runtime* to actually exit.
- **Single instance**: launching again focuses the existing window.

## Planned next (needs a small web API + a webview→Rust bridge)

- Live workspace **status dots** in the tray (running / needs-input / exited),
  polled from the control-plane API.
- **Native notifications** on session state changes.
- **Global hotkey** to summon the window / start a New Workspace.
- Launch-at-login, auto-update.

## Develop

```bash
bun install
bun run tauri dev      # launches the app against the hosted site
```

## Build a distributable .app / .dmg

```bash
bun run tauri build    # outputs to src-tauri/target/release/bundle/
```

## Point at a different environment

The site URL lives in two places: the window `url` in
`src-tauri/tauri.conf.json` and `SITE_URL` in `src-tauri/src/lib.rs`. Change both
(e.g. to `http://localhost:3000`) to run against a local control plane.
