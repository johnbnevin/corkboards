//! Hand a URL to the OS so it opens in the user's default browser.
//!
//! Inside the WebView, `window.open(url, '_blank')` and `<a target="_blank">`
//! are dead ends: WebKitGTK returns null for the former and ignores the latter
//! unless the host implements `create`/`new-window` handling, so on Linux
//! desktop every external link in a note simply did nothing. Routing through
//! the host process fixes that on all three platforms.
//!
//! This is deliberately NOT a generic "open anything" command. Note content and
//! kind-0 profile fields are attacker-controlled, and the webview can invoke any
//! registered command, so an unrestricted opener would let a note launch
//! arbitrary local handlers (`file:`, `smb:`, a private app scheme) or execute a
//! local binary. Only `http`/`https` with a real host gets through, and the URL
//! is always passed as a separate argv entry — never interpolated into a shell.

use std::process::{Command, Stdio};

/// Reject anything that isn't a plain web URL. Mirrors the frontend's
/// `isSafeExternalUrl` so a bypass of one still hits the other.
fn validate(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return Err("url missing or too long".into());
    }
    // Control characters can split a scheme across a line for lenient parsers
    // ("java\nscript:") and never occur in a legitimate URL.
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("url contains control characters".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refused scheme: {}", parsed.scheme()));
    }
    // A host-less http URL ("http:///etc/passwd") is not something a browser
    // should be handed.
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("url has no host".into());
    }
    Ok(parsed.to_string())
}

/// The platform's "open this in whatever handles it" launcher.
///
/// Windows uses `rundll32 url.dll,FileProtocolHandler` rather than `cmd /C
/// start`: `start` treats `&` as a command separator and would turn a query
/// string into command injection even though we never build a shell string.
fn launch(url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(url);
        c
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // spawn(), not status(): xdg-open on some desktops blocks until the
        // browser exits, which would hang the IPC call (and the UI) for as long
        // as the user keeps that browser open.
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch browser: {e}"))
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let safe = validate(&url)?;
    launch(&safe)
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_plain_web_urls() {
        assert!(validate("https://example.com/a?b=c#d").is_ok());
        assert!(validate("  http://example.com  ").is_ok());
    }

    #[test]
    fn rejects_non_web_schemes() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "smb://host/share",
            "data:text/html,<script>",
            "tauri://localhost",
        ] {
            assert!(validate(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn rejects_hostless_and_malformed() {
        assert!(validate("http://").is_err());
        assert!(validate("").is_err());
        assert!(validate("not a url").is_err());
        assert!(validate("https://exa\nmple.com").is_err());
        assert!(validate(&format!("https://example.com/{}", "a".repeat(5000))).is_err());
    }

    /// `http:///a/b` is not host-less to the URL parser — it reads the first
    /// path segment as the host and normalizes to `http://a/b`, an ordinary web
    /// URL. Documented so the host check isn't "fixed" to reject it.
    #[test]
    fn treats_triple_slash_as_a_host() {
        assert_eq!(validate("http:///etc/passwd").unwrap(), "http://etc/passwd");
    }
}
