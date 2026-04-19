mod commands;

use commands::{history, screenshots, sessions, settings, window};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = window::position_bottom_right_sync(&win);
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::read_settings,
            settings::write_settings,
            sessions::read_sessions,
            sessions::write_sessions,
            history::read_history,
            history::write_history,
            history::delete_session_data,
            screenshots::save_screenshot,
            screenshots::get_screenshot_path,
            window::set_always_on_top,
            window::position_bottom_right,
            window::animate_expand,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flick");
}
