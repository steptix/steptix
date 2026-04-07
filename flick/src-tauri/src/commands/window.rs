use tauri::Manager;

#[tauri::command]
pub async fn set_always_on_top(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    window
        .set_always_on_top(pinned)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn position_bottom_right(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;

    if let Some(monitor) = monitor {
        let screen_size = monitor.size();
        let screen_pos = monitor.position();
        let win_size = window.inner_size().map_err(|e| e.to_string())?;

        let x = screen_pos.x + screen_size.width as i32 - win_size.width as i32 - 16;
        let y = screen_pos.y + screen_size.height as i32 - win_size.height as i32 - 48;

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn animate_expand(
    app: tauri::AppHandle,
    target_height: u32,
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    let current_size = window.inner_size().map_err(|e| e.to_string())?;
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;

    let start_height = current_size.height;
    if target_height <= start_height {
        return Ok(());
    }

    let steps = 20u32;
    let height_diff = target_height - start_height;

    for i in 1..=steps {
        let progress = i as f64 / steps as f64;
        let eased = 1.0 - (1.0 - progress).powi(3);

        let new_height = start_height + (height_diff as f64 * eased) as u32;
        let y_offset = (height_diff as f64 * eased) as i32;

        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: current_size.width,
                height: new_height,
            }))
            .map_err(|e| e.to_string())?;

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: current_pos.x,
                y: current_pos.y - y_offset,
            }))
            .map_err(|e| e.to_string())?;

        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }

    Ok(())
}
