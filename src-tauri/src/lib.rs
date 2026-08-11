use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// Holds the Node backend child process so we can kill it when the window closes.
struct SidecarChild(Mutex<Option<CommandChild>>);

/// A newer release than the one running, as the Updates settings page needs it.
#[derive(Clone, serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: String,
}

/// Asks GitHub Releases whether there is a newer signed build. Pure query: it
/// neither prompts nor installs, so the UI owns the decision.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone().unwrap_or_default(),
    }))
}

/// Downloads and installs the pending update, then restarts.
///
/// Re-checks rather than holding the Update handle between commands: it costs
/// one request and avoids keeping download state alive across the IPC boundary.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update is available.".to_string())?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // The NSIS installer runs in passive mode and relaunches Catalyst itself,
    // but the old process has to go for the upgrade to complete cleanly.
    app.restart();
}

/// Reads the "install updates automatically" preference out of the settings file
/// the Node backend owns (~/.catalyst/sessions.json, see lib/paths.js).
///
/// Rust reads the file instead of having the frontend hand the flag over: the
/// startup check runs before the sidecar has even reported its port, so there is
/// no page to ask yet, and waiting for one would either delay the check or race
/// it. Anything unexpected — no file, bad JSON, missing key — means opted out,
/// because an unattended install must only ever follow an explicit opt-in.
fn auto_update_enabled(app: &tauri::AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(home.join(".catalyst").join("sessions.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    json.get("settings")
        .and_then(|s| s.get("autoUpdate"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Startup check. Stays silent when already current; otherwise installs straight
/// away if the user opted into automatic updates, and falls back to a native
/// prompt so the update is seen without them opening Settings.
async fn startup_update_check(app: tauri::AppHandle) -> Result<(), String> {
    let Some(info) = check_for_updates(app.clone()).await? else {
        return Ok(());
    };

    // Opted in: skip the question, not the checks. install_update goes through
    // the same updater, so the release signature is still verified before
    // anything touches the installed app.
    if auto_update_enabled(&app) {
        return install_update(app).await;
    }

    let notes = info.notes.trim();
    let prompt = if notes.is_empty() {
        format!(
            "Catalyst {} is available.\n\nInstall it now? Catalyst will restart.",
            info.version
        )
    } else {
        format!(
            "Catalyst {} is available.\n\n{notes}\n\nInstall it now? Catalyst will restart.",
            info.version
        )
    };

    // blocking_show() must not run on the main thread; the caller reaches this
    // from an async_runtime task, which is a worker.
    let approved = app
        .dialog()
        .message(prompt)
        .kind(MessageDialogKind::Info)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install & Restart".to_string(),
            "Later".to_string(),
        ))
        .blocking_show();

    if approved {
        install_update(app).await?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
                win.dialog()
                    .message("Catalyst is already running.")
                    .kind(MessageDialogKind::Info)
                    .title("Catalyst")
                    .blocking_show();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![check_for_updates, install_update])
        .manage(SidecarChild(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // Silent update check on launch. Runs detached so a slow or offline
            // GitHub never delays the window or the backend spawn below.
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = startup_update_check(updater_handle).await {
                    eprintln!("[updater] check failed: {err}");
                }
            });

            // The Node entry point: repo source in dev, staged resource in release.
            let server_js: std::path::PathBuf = if cfg!(debug_assertions) {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("manifest dir has a parent")
                    .join("server.js")
            } else {
                app.path()
                    .resource_dir()?
                    .join("sidecar")
                    .join("server.js")
            };

            // resource_dir() can hand back a Windows verbatim path (\\?\C:\...),
            // which node mis-parses as its main module — it sees just "C:" and
            // dies with EISDIR. Strip the prefix so node gets a plain path.
            let mut server_arg = server_js.to_string_lossy().to_string();
            if let Some(stripped) = server_arg.strip_prefix(r"\\?\") {
                server_arg = stripped.to_string();
            }

            // Spawn the bundled Node runtime running the existing server unchanged.
            let sidecar = app
                .shell()
                .sidecar("catalyst-server")
                .expect("failed to create sidecar command")
                .arg(server_arg)
                .env("CATALYST_DESKTOP", "1");

            let (mut rx, child) = sidecar.spawn().expect("failed to spawn backend");
            app.state::<SidecarChild>()
                .0
                .lock()
                .unwrap()
                .replace(child);

            // Watch the backend's stdout for the readiness line, then point the
            // window at the local server. The server picks its own free port, so
            // we learn the actual one from its output rather than assuming 4200.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            if let Some(rest) = line.split("CATALYST_LISTENING ").nth(1) {
                                let port: String =
                                    rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                                if !port.is_empty() {
                                    let url = format!("http://localhost:{}/", port);
                                    if let Some(win) = handle.get_webview_window("main") {
                                        if let Ok(parsed) = url.parse() {
                                            let _ = win.navigate(parsed);
                                        }
                                    }
                                }
                            }
                            print!("[backend] {}", line);
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprint!("[backend] {}", String::from_utf8_lossy(&bytes));
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<SidecarChild>() {
                        if let Some(child) = state.0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
