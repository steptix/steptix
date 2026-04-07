mod commands;

use commands::{history, screenshots, sessions, settings, window};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
