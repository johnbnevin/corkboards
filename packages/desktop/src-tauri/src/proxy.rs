//! SOCKS5 proxy configuration for relay connections.
//!
//! Persists user-selected proxy URL (e.g. `socks5h://127.0.0.1:9050` for Tor)
//! to a small JSON file in the platform-specific app data directory, and exposes
//! it through a process-wide mutex so `relay.rs` can read it cheaply on every
//! connection.
//!
//! Cypherpunk note: when set, every NATIVE relay query (outbox lookups and REQ
//! subscriptions routed through Rust) goes through SOCKS5 — the user's IP and
//! the contents of Nostr filters (followed pubkeys, hashtags, DM-recipient
//! pubkey) never reach the relay over a direct connection. `socks5h://` resolves
//! the relay hostname through the proxy (Tor-style), preventing local DNS leaks.
//!
//! `proxy_required` is a kill-switch: when set, `relay.rs` MUST refuse to fall
//! back to a direct clearnet connection if the proxy is unset or fails — so a
//! Tor-only user is never silently deanonymized by a missing/failed proxy.
//!
//! NOTE: this only covers native Rust relay traffic. WebView WebSockets and
//! HTTP(S) (images, etc.) are handled by WebKit and do NOT traverse this proxy.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, Once};

/// The full proxy state behind ONE mutex, held across mutate-and-persist so two
/// concurrent IPC calls can never interleave into a stale url/required combo on
/// disk (for a Tor user, a resurrected `required=false` matters).
struct ProxyConfig {
    url: Option<String>,
    required: bool,
    /// Set when the on-disk config existed but could not be parsed — surfaced to
    /// the UI so a Tor user knows their proxy setting may not have loaded.
    load_failed: bool,
}

static CONFIG: Mutex<ProxyConfig> = Mutex::new(ProxyConfig {
    url: None,
    required: false,
    load_failed: false,
});
static INIT: Once = Once::new();
/// Whether this session's WebView was actually routed through a proxy. Latched at
/// window creation (the WebView's proxy can't change without a restart), but the
/// *warning* derived from it is computed live against `proxy_required()` — see
/// `proxy_webview_unprotected` — so toggling "require proxy" on AFTER launch
/// still surfaces that WebView traffic (images, embeds, any relay socket opened
/// from JS) is going out directly. The relay.rs kill-switch only covers native
/// Rust sockets, so without this a Tor-only user could be silently deanonymized.
static WEBVIEW_PROXIED: Mutex<bool> = Mutex::new(false);

fn config_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    Some(base.join("me.corkboards.desktop").join("proxy.json"))
}

/// Lock helper that recovers from a poisoned mutex instead of panicking.
fn lock<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn load_from_disk() {
    let Some(path) = config_path() else { return };
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        // No file yet is normal (proxy unconfigured); only flag real read errors.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            lock(&CONFIG).load_failed = true;
            return;
        }
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
        lock(&CONFIG).load_failed = true;
        return;
    };
    let mut cfg = lock(&CONFIG);
    if let Some(s) = v.get("url").and_then(|x| x.as_str()) {
        if !s.is_empty() {
            cfg.url = Some(s.to_string());
        }
    }
    if let Some(req) = v.get("required").and_then(|x| x.as_bool()) {
        cfg.required = req;
    }
}

/// Returns the currently configured SOCKS5 proxy URL, or `None` for direct.
/// First call also loads from disk; subsequent calls read the in-memory value.
pub fn current_proxy() -> Option<String> {
    INIT.call_once(load_from_disk);
    lock(&CONFIG).url.clone()
}

/// True when the user requires all native relay traffic to go through the proxy.
/// `relay.rs` must error rather than connect directly when this is set.
pub fn proxy_required() -> bool {
    INIT.call_once(load_from_disk);
    lock(&CONFIG).required
}

/// Owner read/write only: the file can name a private SOCKS endpoint, and the
/// default umask would leave it world-readable. No-op off unix (Windows ACLs
/// already restrict the app-data dir). Same policy as logger.rs.
#[cfg(unix)]
fn restrict_perms(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &std::path::Path) {}

fn save_to_disk(cfg: &ProxyConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "no config dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body =
        serde_json::json!({ "url": cfg.url.as_deref().unwrap_or(""), "required": cfg.required })
            .to_string();
    fs::write(&path, body).map_err(|e| format!("write: {e}"))?;
    restrict_perms(&path);
    Ok(())
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
    // relay.rs connects with host:port only — credentials in the URL would be
    // silently ignored AND persisted to disk in plaintext. Refuse them.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("proxy credentials in the URL are not supported — use an unauthenticated local proxy (e.g. Tor on 127.0.0.1:9050)".to_string());
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
    let mut cfg = lock(&CONFIG);
    cfg.url = normalized;
    cfg.load_failed = false;
    save_to_disk(&cfg)
}

#[tauri::command]
pub fn get_proxy() -> Option<String> {
    current_proxy()
}

/// Enable/disable the "require proxy" kill-switch.
#[tauri::command]
pub fn set_proxy_required(required: bool) -> Result<(), String> {
    INIT.call_once(load_from_disk);
    let mut cfg = lock(&CONFIG);
    cfg.required = required;
    save_to_disk(&cfg)
}

#[tauri::command]
pub fn get_proxy_required() -> bool {
    proxy_required()
}

/// True if the proxy config file existed but failed to parse — the UI should
/// warn the user that their proxy setting may not be active.
#[tauri::command]
pub fn proxy_load_failed() -> bool {
    INIT.call_once(load_from_disk);
    lock(&CONFIG).load_failed
}

/// Record (at window creation) whether the WebView was routed through a proxy.
/// See `WEBVIEW_PROXIED`.
pub fn set_webview_proxied(proxied: bool) {
    *lock(&WEBVIEW_PROXIED) = proxied;
}

/// True when `proxy_required` is on but this session's WebView is NOT routed
/// through a proxy — the UI must warn that non-relay traffic is going direct.
/// Computed live so enabling "require proxy" after launch surfaces the warning,
/// even though the WebView's actual proxy state is fixed until restart.
#[tauri::command]
pub fn proxy_webview_unprotected() -> bool {
    proxy_required() && !*lock(&WEBVIEW_PROXIED)
}
