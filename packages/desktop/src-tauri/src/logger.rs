use std::fs::OpenOptions;
use std::io::Write;

fn log_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    format!("{}/.local/share/me.corkboards.desktop/debug.log", home)
}

fn ensure_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn write_log(message: String) -> Result<(), String> {
    let path = log_path();
    ensure_dir(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", message).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_log() -> Result<(), String> {
    let path = log_path();
    ensure_dir(&path)?;
    std::fs::write(&path, "=== Corkboards log start ===\n").map_err(|e| e.to_string())
}
