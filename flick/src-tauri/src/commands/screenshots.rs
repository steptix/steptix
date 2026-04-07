use base64::Engine;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn screenshots_dir(app: &tauri::AppHandle, session_id: &str) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("screenshots")
        .join(session_id);
    fs::create_dir_all(&dir).ok();
    dir
}

#[tauri::command]
pub fn save_screenshot(
    app: tauri::AppHandle,
    session_id: String,
    step_index: u32,
    base64_data: String,
) -> Result<String, String> {
    let raw = base64_data
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&base64_data);

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| e.to_string())?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();

    let filename = format!("{timestamp}_{step_index}.png");
    let dir = screenshots_dir(&app, &session_id);
    let path = dir.join(&filename);

    fs::write(&path, bytes).map_err(|e| e.to_string())?;

    Ok(filename)
}

#[tauri::command]
pub fn get_screenshot_path(
    app: tauri::AppHandle,
    session_id: String,
    filename: String,
) -> Result<String, String> {
    let path = screenshots_dir(&app, &session_id).join(&filename);
    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err("Screenshot not found".to_string())
    }
}
