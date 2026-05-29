use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

/// Truncate the log once it grows past this size so an always-on console
/// forward can't fill the disk between restarts.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

fn log_path() -> Option<PathBuf> {
    // Use the same platform-specific app-data dir as proxy.rs for consistency.
    let base = dirs::data_local_dir()?;
    Some(base.join("me.corkboards.desktop").join("debug.log"))
}

fn ensure_dir(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Defense-in-depth: scrub unambiguous secrets before they touch the plaintext
/// log file. We redact bech32 `nsec1`/`ncryptsec1` keys and `secret=` params.
/// Bare 64-hex is intentionally NOT redacted — pubkeys and event ids share that
/// shape and are public; blanket-redacting them would gut the logs' usefulness.
fn redact_secrets(input: &str) -> String {
    let mut out = redact_bech32(input, "ncryptsec1");
    out = redact_bech32(&out, "nsec1");
    out = redact_secret_param(&out);
    out
}

/// Replace `<prefix><bech32-chars…>` with `<prefix>[REDACTED]`.
fn redact_bech32(input: &str, prefix: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(prefix) {
        result.push_str(&rest[..pos]);
        result.push_str(prefix);
        result.push_str("[REDACTED]");
        // Skip the prefix and the run of bech32 data chars that follow it.
        let after = &rest[pos + prefix.len()..];
        let data_len = after
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(after.len());
        rest = &after[data_len..];
    }
    result.push_str(rest);
    result
}

/// Replace `secret=<value>` with `secret=[REDACTED]` (stops at `&`, whitespace, quote).
fn redact_secret_param(input: &str) -> String {
    let needle = "secret=";
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(needle) {
        result.push_str(&rest[..pos]);
        result.push_str(needle);
        result.push_str("[REDACTED]");
        let after = &rest[pos + needle.len()..];
        let val_len = after
            .find(|c: char| c == '&' || c == '"' || c == '\'' || c.is_whitespace())
            .unwrap_or(after.len());
        rest = &after[val_len..];
    }
    result.push_str(rest);
    result
}

#[tauri::command]
pub fn write_log(message: String) -> Result<(), String> {
    let path = log_path().ok_or_else(|| "no data dir".to_string())?;
    ensure_dir(&path)?;

    // Size cap: truncate (keeping a marker) before appending if the file is huge.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::write(&path, "=== Corkboards log truncated (size cap) ===\n");
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", redact_secrets(&message)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_log() -> Result<(), String> {
    let path = log_path().ok_or_else(|| "no data dir".to_string())?;
    ensure_dir(&path)?;
    std::fs::write(&path, "=== Corkboards log start ===\n").map_err(|e| e.to_string())
}
