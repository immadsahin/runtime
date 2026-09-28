// Runtime desktop shell.
//
// The window loads the hosted Runtime web UI directly (which itself opens the
// terminal WebSocket straight to the Daytona box), so this native layer stays
// thin: a tray-resident window, a tray menu, hide-to-tray on close, and
// single-instance focus.
//
// Auth: GitHub OAuth is completed in the system browser, not the embedded
// webview. We (1) flag the page as running in the desktop app, (2) open any
// off-site navigation (the OAuth provider) in the system browser, and (3) catch
// the `runtime://auth/callback?code=…` deep link and feed the code back to the
// webview's own `/auth/callback`, so the PKCE verifier never leaves the webview
// and the session cookie lands in the right place.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;

const SITE: &str = "https://runtime.zerotrail.ai";
const SITE_HOST: &str = "runtime.zerotrail.ai";

/// Injected into the page so the web app knows it runs inside the desktop shell
/// and can route sign-in through the system browser.
const INIT_JS: &str = "window.__RUNTIME_DESKTOP__ = true;";

/// Reveal + focus the main window (from the tray, dock, or a second launch).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: focus the existing window instead of
        // spawning a second instance (and forward any deep link it carried).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Main window → hosted Runtime UI, flagged as the desktop shell, with
            // off-site navigations (OAuth) bounced to the system browser.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SITE.parse().unwrap()))
                .title("Outrunner")
                .inner_size(1280.0, 860.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(INIT_JS)
                .on_navigation(|url| {
                    let scheme = url.scheme();
                    let same_site = url.host_str() == Some(SITE_HOST);
                    // Allow the app's own pages and internal webview loads.
                    if same_site || matches!(scheme, "about" | "data" | "blob") {
                        return true;
                    }
                    // Everything else (OAuth provider, external links) opens in
                    // the system browser instead of the embedded webview.
                    let _ = open::that(url.as_str());
                    false
                })
                .build()?;

            // Feed the OAuth deep link back to the webview's own callback so the
            // code exchange (and session cookie) happens in the webview.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() != "runtime" {
                        continue;
                    }
                    let query = url.query().unwrap_or("");
                    let target = format!("{SITE}/auth/callback?{query}");
                    if let (Some(window), Ok(parsed)) =
                        (handle.get_webview_window("main"), target.parse())
                    {
                        let _ = window.navigate(parsed);
                    }
                    show_main(&handle);
                }
            });

            // Tray menu.
            let show_i = MenuItem::with_id(app, "show", "Show Outrunner", true, None::<&str>)?;
            let new_i = MenuItem::with_id(app, "new", "New Workspace", true, None::<&str>)?;
            let reload_i = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Outrunner", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &new_i, &reload_i, &sep, &quit_i])?;

            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Outrunner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "new" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.navigate(format!("{SITE}/new").parse().unwrap());
                        }
                        show_main(app);
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("location.reload()");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click toggles the window like a menu-bar app.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                show_main(app);
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray instead of quitting; use
            // the tray's "Quit Outrunner" to exit. Keeps the session reachable.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Outrunner");
}
