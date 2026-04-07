use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub step: String,
    pub status: String,
    pub actions: serde_json::Value,
    pub screenshot_file: Option<String>,
    pub reasoning: String,
    pub outputs: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub status: String,
    pub steps_completed: u32,
    pub steps_total: u32,
    pub results: Vec<StepResult>,
    pub outputs: serde_json::Value,
    pub error: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ChatEntry {
    UserMessage { text: String, timestamp: String },
    ResultMessage { result: BatchResult, timestamp: String },
    ErrorMessage { message: String, timestamp: String },
}

fn history_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("history");
    fs::create_dir_all(&dir).ok();
    dir
}

fn history_path(app: &tauri::AppHandle, session_id: &str) -> PathBuf {
    history_dir(app).join(format!("{session_id}.json"))
}

#[tauri::command]
pub fn read_history(app: tauri::AppHandle, session_id: String) -> Vec<ChatEntry> {
    let path = history_path(&app, &session_id);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}

#[tauri::command]
pub fn write_history(
    app: tauri::AppHandle,
    session_id: String,
    entries: Vec<ChatEntry>,
) -> Result<(), String> {
    let path = history_path(&app, &session_id);
    let data = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_session_data(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let hist = history_path(&app, &session_id);
    if hist.exists() {
        fs::remove_file(&hist).map_err(|e| e.to_string())?;
    }

    let screenshots_dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("screenshots")
        .join(&session_id);
    if screenshots_dir.exists() {
        fs::remove_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}
