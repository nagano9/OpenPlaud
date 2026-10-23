use serde::Serialize;
use tauri::Manager;
mod plaud;
#[cfg(desktop)]
mod desktop_exports;

#[cfg(desktop)]
use std::{fs, net::UdpSocket, path::PathBuf};
#[cfg(desktop)]
use std::sync::Mutex;
// Only the opt-in macOS Swift fallback resolves bundled resources.
#[cfg(all(desktop, target_os = "macos"))]
use tauri::path::BaseDirectory;
#[cfg(desktop)]
use tauri::RunEvent;
#[cfg(desktop)]
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[cfg(desktop)]
const SERVICE_PORT: u16 = 3487;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
  mode: &'static str,
  service_origin: Option<String>,
  pairing_token: Option<String>,
  lan_address: Option<String>,
}

#[cfg(desktop)]
struct SidecarState(Mutex<Option<CommandChild>>);

#[tauri::command]
fn runtime_info(info: tauri::State<'_, RuntimeInfo>) -> RuntimeInfo {
  info.inner().clone()
}

#[cfg(desktop)]
fn local_lan_address() -> Option<String> {
  let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
  socket.connect("8.8.8.8:80").ok()?;
  let ip = socket.local_addr().ok()?.ip();
  Some(format!("http://{ip}:{SERVICE_PORT}"))
}

#[cfg(desktop)]
fn read_or_create_token(app_data_dir: &PathBuf) -> Result<String, Box<dyn std::error::Error>> {
  let token_path = app_data_dir.join("pairing-token");
  if let Ok(token) = fs::read_to_string(&token_path) {
    let token = token.trim();
    if !token.is_empty() {
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600))?;
      }
      return Ok(token.to_owned());
    }
  }
  let token = uuid::Uuid::new_v4().simple().to_string();
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&token_path)?.write_all(token.as_bytes())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600))?;
  }
  #[cfg(not(unix))]
  fs::write(&token_path, &token)?;
  Ok(token)
}

#[cfg(desktop)]
fn ble_bridge_path() -> Option<PathBuf> {
  let directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
  let name = if cfg!(windows) { "plaud-bridge.exe" } else { "plaud-bridge" };
  let path = directory.join(name);
  path.is_file().then_some(path)
}

/// Where the vault lives: `OPENPLOD_VAULT_DIR`, else the folder named in `vault-location` inside the
/// app data folder (so an existing vault, its pairing and its paired phones keep working), else the
/// app data folder itself.
#[cfg(desktop)]
fn vault_dir(app_data_dir: &PathBuf) -> PathBuf {
  std::env::var_os("OPENPLOD_VAULT_DIR").map(PathBuf::from)
    .or_else(|| fs::read_to_string(app_data_dir.join("vault-location")).ok()
      .map(|value| PathBuf::from(value.trim())).filter(|path| !path.as_os_str().is_empty()))
    .unwrap_or_else(|| app_data_dir.clone())
}

#[cfg(desktop)]
fn start_service(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let app_data_dir = app.path().app_data_dir()?;
  fs::create_dir_all(&app_data_dir)?;
  let vault = vault_dir(&app_data_dir);
  fs::create_dir_all(&vault)?;
  let library_dir = vault.join("recordings");
  fs::create_dir_all(&library_dir)?;
  let pairing_token = read_or_create_token(&vault)?;
  // A vault first run from source keeps its database as plaud.db.
  let database = [vault.join("openplod.db"), vault.join("plaud.db")].into_iter().find(|path| path.is_file())
    .unwrap_or_else(|| vault.join("openplod.db"));

  let command = app
    .shell()
    .sidecar("openplod-server")?
    .current_dir(&vault)
    .env("HOST", "0.0.0.0")
    .env("PORT", SERVICE_PORT.to_string())
    .env("DATABASE_URL", database)
    .env("OPENPLOD_LIBRARY_PATH", library_dir)
    .env("OPENPLOD_PAIRING_TOKEN", &pairing_token);
  // Every desktop platform speaks Bluetooth through the same bundled
  // `plaud-bridge` binary (CoreBluetooth, BlueZ or WinRT under one protocol).
  let command = match ble_bridge_path() {
    Some(bridge) => command.env("OPENPLOD_BLE_BRIDGE", bridge),
    None => command,
  };
  // The macOS Swift helpers remain shipped as an opt-in fallback backend
  // (`OPENPLOD_BLE_BACKEND=swift`); they are never selected automatically.
  #[cfg(target_os = "macos")]
  let command = command
    .env(
      "OPENPLOD_BLE_SCRIPT",
      app.path().resolve("resources/plaud-bridge.swift", BaseDirectory::Resource)?,
    )
    .env(
      "OPENPLOD_SCAN_SCRIPT",
      app.path().resolve("resources/scan-plaud.swift", BaseDirectory::Resource)?,
    );
  let (mut events, child) = command.spawn()?;
  tauri::async_runtime::spawn(async move {
    // Drain sidecar output without persisting potentially private request details.
    while events.recv().await.is_some() {}
  });

  app.manage(SidecarState(Mutex::new(Some(child))));
  app.manage(RuntimeInfo {
    mode: "desktop",
    service_origin: Some(format!("http://127.0.0.1:{SERVICE_PORT}")),
    pairing_token: Some(pairing_token),
    lan_address: local_lan_address(),
  });
  Ok(())
}

/// Passed by the sign-in launcher: start the vault without showing the window.
#[cfg(desktop)]
const BACKGROUND_ARG: &str = "--background";

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// The vault keeps serving the paired phone while the window is closed: a tray icon reopens or quits
/// it, and on first run OpenPlod is set to start in the tray when the person signs in (they can turn
/// that off in Windows' Startup apps).
#[cfg(desktop)]
fn background(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  use tauri::menu::{Menu, MenuItem};
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
  use tauri_plugin_autostart::ManagerExt;

  let open = MenuItem::with_id(app, "open", "Open OpenPlod", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit (stops the vault)", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&open, &quit])?;
  let mut tray = TrayIconBuilder::with_id("vault").tooltip("OpenPlod vault").menu(&menu).show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "open" => show_main(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event { show_main(tray.app_handle()) }
    });
  if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
  tray.build(app)?;

  let marker = app.path().app_data_dir()?.join("autostart-offered");
  if !marker.exists() {
    let _ = app.autolaunch().enable();
    let _ = fs::write(&marker, "1");
  }
  // The window starts hidden (tauri.conf.json) so a sign-in launch does not flash it.
  if !std::env::args().any(|arg| arg == BACKGROUND_ARG) { show_main(app.handle()); }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(plaud::init())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      #[cfg(desktop)]
      {
        start_service(app)?;
        background(app)?;
      }

      #[cfg(mobile)]
      app.manage(RuntimeInfo {
        mode: "mobile",
        service_origin: None,
        pairing_token: None,
        lan_address: None,
      });

      Ok(())
    });

  // REL-07: update checks verify the release signature against the build-time public key.
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![BACKGROUND_ARG])))
    // Closing the window keeps the vault running in the tray; Quit in the tray menu stops it.
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    });

  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    runtime_info, plaud::plaud_command, desktop_exports::export_document, desktop_exports::export_audio,
    desktop_exports::pick_export_folder
  ]);
  #[cfg(mobile)]
  let builder = builder.invoke_handler(tauri::generate_handler![runtime_info, plaud::plaud_command]);

  builder
    .build(tauri::generate_context!())
    .expect("error while building OpenPlod")
    .run(|_app_handle, _event| {
      #[cfg(desktop)]
      if matches!(_event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
        if let Some(state) = _app_handle.try_state::<SidecarState>() {
          if let Ok(mut child) = state.0.lock() {
            if let Some(child) = child.take() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
