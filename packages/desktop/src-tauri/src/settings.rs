//! Local desktop preferences that the Rust side needs to honor.
//!
//! Separate from `proxy.rs` because these are UI/privacy toggles rather than
//! network configuration, but the storage design is deliberately identical:
//! one mutex covering the whole struct, held across mutate-and-persist so two
//! concurrent IPC calls can't interleave a stale combination onto disk, and
//! 0600 perms because the file records what the user chose to keep private.
//!
//! Both settings exist because a default is a kindness and a lock is not:
//!
//! - `file_logging` gates the plaintext activity log in `logger.rs`. That log
//!   is a local forensic record of browsing behavior (relay selections, RSS
//!   subscription URLs, timestamps), so it ships OFF and the user turns it on
//!   deliberately when they want to capture a session for a bug report.
//! - `content_protected` asks the OS to exclude the window from screen capture.
//!   Good for a shoulder-surfing threat model, but it also blocks the user's
//!   OWN screenshots and screen-sharing, so it must be theirs to switch off.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, Once};

struct Settings {
    /// Write console output to `debug.log`. Off by default (see module docs).
    file_logging: bool,
    /// Ask the OS to exclude the window from screen capture. On by default.
    content_protected: bool,
}

static SETTINGS: Mutex<Settings> = Mutex::new(Settings {
    file_logging: false,
    content_protected: true,
});
static INIT: Once = Once::new();

fn config_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    Some(base.join("me.corkboards.desktop").join("settings.json"))
}

/// Lock helper that recovers from a poisoned mutex instead of panicking.
fn lock<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn load_from_disk() {
    let Some(path) = config_path() else { return };
    let Ok(content) = fs::read_to_string(&path) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { return };
    let mut s = lock(&SETTINGS);
    if let Some(b) = v.get("fileLogging").and_then(|x| x.as_bool()) {
        s.file_logging = b;
    }
    if let Some(b) = v.get("contentProtected").and_then(|x| x.as_bool()) {
        s.content_protected = b;
    }
}

/// Owner read/write only — same policy as the proxy config and the log itself.
#[cfg(unix)]
fn restrict_perms(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &std::path::Path) {}

fn save_to_disk(s: &Settings) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "no config dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body = serde_json::json!({
        "fileLogging": s.file_logging,
        "contentProtected": s.content_protected,
    })
    .to_string();
    fs::write(&path, body).map_err(|e| format!("write: {e}"))?;
    restrict_perms(&path);
    Ok(())
}

/// Whether `logger::write_log` should persist anything. Read on every log line,
/// so it stays a cheap mutex read rather than a disk touch.
pub fn file_logging_enabled() -> bool {
    INIT.call_once(load_from_disk);
    lock(&SETTINGS).file_logging
}

/// Whether the main window should be created with screen-capture protection.
pub fn content_protected() -> bool {
    INIT.call_once(load_from_disk);
    lock(&SETTINGS).content_protected
}

#[tauri::command]
pub fn get_file_logging() -> bool {
    file_logging_enabled()
}

#[tauri::command]
pub fn set_file_logging(enabled: bool) -> Result<(), String> {
    INIT.call_once(load_from_disk);
    let mut s = lock(&SETTINGS);
    s.file_logging = enabled;
    save_to_disk(&s)
}

#[tauri::command]
pub fn get_content_protected() -> bool {
    content_protected()
}

/// Takes effect on the next launch: the flag is applied when the window is
/// built, and Tauri has no supported way to flip it on a live window. The UI
/// tells the user that rather than pretending the change was immediate.
#[tauri::command]
pub fn set_content_protected(enabled: bool) -> Result<(), String> {
    INIT.call_once(load_from_disk);
    let mut s = lock(&SETTINGS);
    s.content_protected = enabled;
    save_to_disk(&s)
}
