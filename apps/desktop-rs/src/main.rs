//! Glyphi Teams, Rust shell.
//!
//! This replaces the Electron main process. What Electron gave for free has to be
//! written here, and the migration is done in that order:
//!
//!   1. the window            — Tauri + WebView2, loading the same renderer bundle
//!   2. the counting proxy    — `glyphi-proxy`, started as a sidecar on launch
//!   3. the history database  — rusqlite over the same `history.sqlite` schema
//!   4. the provider readers  — ported one at a time, each with its own tests
//!   5. tray, updates, deep links, IPC commands
//!
//! Steps 1 and 2 are wired here; the rest is tracked in the README.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use tauri::Manager;

/// Kept alive for the life of the window: dropping it kills the proxy.
struct ProxyProcess(std::sync::Mutex<Option<Child>>);

fn proxy_path() -> Option<PathBuf> {
    // Next to the shell in a packaged build, or in the workspace target folder
    // while developing.
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            candidates.push(directory.join("glyphi-proxy.exe"));
            candidates.push(directory.join("glyphi-proxy"));
        }
    }
    if let Ok(profile) = std::env::var("PROFILE") {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/glyphi-proxy/target")
                .join(profile)
                .join(if cfg!(windows) { "glyphi-proxy.exe" } else { "glyphi-proxy" }),
        );
    }
    candidates.into_iter().find(|path| path.exists())
}

fn start_proxy() -> Option<Child> {
    let path = proxy_path()?;
    let port = std::env::var("GLYPHI_PROXY_PORT").unwrap_or_else(|_| "4787".to_string());
    Command::new(path)
        .env("GLYPHI_PROXY_PORT", port)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

fn main() {
    let proxy = start_proxy();

    tauri::Builder::default()
        .manage(ProxyProcess(std::sync::Mutex::new(proxy)))
        .invoke_handler(tauri::generate_handler![proxy_url])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Glyphi Teams");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Glyphi Teams could not start")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<ProxyProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(mut child) = child.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

/// The renderer asks for this once on boot to point its usage cards at the proxy.
#[tauri::command]
fn proxy_url() -> String {
    let port = std::env::var("GLYPHI_PROXY_PORT").unwrap_or_else(|_| "4787".to_string());
    format!("http://127.0.0.1:{port}")
}
