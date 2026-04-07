use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    pub tab_order: u32,
    pub first_request_sent: bool,
}

fn sessions_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("failed to get app data dir");
    fs::create_dir_all(&dir).ok();
    dir.join("sessions.json")
}

#[tauri::command]
pub fn read_sessions(app: tauri::AppHandle) -> Vec<SessionMeta> {
    let path = sessions_path(&app);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}

#[tauri::command]
pub fn write_sessions(app: tauri::AppHandle, sessions: Vec<SessionMeta>) -> Result<(), String> {
    let path = sessions_path(&app);
    let data = serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}
