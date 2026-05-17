//! SOCKS5 proxy configuration for relay connections.
//!
//! Persists user-selected proxy URL (e.g. `socks5h://127.0.0.1:9050` for Tor)
//! to a small JSON file in the platform-specific app data directory, and exposes
//! it through a process-wide `Mutex<Option<String>>` so `relay.rs` can read it
//! cheaply on every connection.
//!
//! Cypherpunk note: when set, every relay query (including outbox lookups and
//! REQ subscriptions) goes through SOCKS5. The user's IP and the contents of
//! Nostr filters — pubkeys followed, hashtags subscribed, DM-recipient pubkey —
//! never reach the relay over a direct connection. `socks5h://` resolves the
//! relay hostname through the proxy (Tor-style), preventing local DNS leaks.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, Once};

static PROXY_URL: Mutex<Option<String>> = Mutex::new(None);
static INIT: Once = Once::new();

fn config_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    Some(base.join("me.corkboards.desktop").join("proxy.json"))
}

fn load_from_disk() {
    let Some(path) = config_path() else { return };
    let Ok(content) = fs::read_to_string(&path) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { return };
    if let Some(s) = v.get("url").and_then(|x| x.as_str()) {
        if !s.is_empty() {
            *PROXY_URL.lock().unwrap() = Some(s.to_string());
        }
    }
}

/// Returns the currently configured SOCKS5 proxy URL, or `None` for direct.
/// First call also loads from disk; subsequent calls read the in-memory value.
pub fn current_proxy() -> Option<String> {
    INIT.call_once(load_from_disk);
    PROXY_URL.lock().unwrap().clone()
}

fn save_to_disk(url: Option<&str>) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "no config dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body = serde_json::json!({ "url": url.unwrap_or("") }).to_string();
    fs::write(&path, body).map_err(|e| format!("write: {e}"))
}

fn validate(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid proxy URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "socks5" && scheme != "socks5h" {
        return Err(format!("proxy scheme must be socks5 or socks5h, got '{scheme}'"));
    }
    if parsed.host_str().is_none() || parsed.port().is_none() {
        return Err("proxy URL must include host and port".to_string());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn set_proxy(url: Option<String>) -> Result<(), String> {
    INIT.call_once(load_from_disk);
    let normalized = match url.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(s) => Some(validate(s)?),
    };
    *PROXY_URL.lock().unwrap() = normalized.clone();
    save_to_disk(normalized.as_deref())
}

#[tauri::command]
pub fn get_proxy() -> Option<String> {
    current_proxy()
}
