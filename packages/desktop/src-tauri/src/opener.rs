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

/// Reject anything that isn't a `lightning:` URI wrapping a BOLT-11 invoice.
///
/// `open_external` refuses non-web schemes for good reason, and this does not
/// relax that: it is a second, single-purpose door that only a real invoice
/// fits through. An invoice is `ln` + network prefix + optional amount + `1` +
/// bech32 data, with no host, path, query or credentials for a local handler to
/// be tricked by — so validating the shape here is enough, and note content
/// cannot be shaped into anything this accepts.
fn validate_lightning(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return Err("invoice missing or too long".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("invoice contains control characters".into());
    }
    let rest = trimmed
        .strip_prefix("lightning:")
        .or_else(|| trimmed.strip_prefix("LIGHTNING:"))
        .ok_or("not a lightning: URI")?;
    // Case-insensitive per bech32; normalize once so the checks below are ASCII.
    let payload = rest.to_ascii_lowercase();
    let after_prefix = ["lnbcrt", "lnbc", "lntb", "lnsb"]
        .iter()
        .find_map(|p| payload.strip_prefix(p))
        .ok_or("not a BOLT-11 invoice")?;
    // The separator is the LAST `1`: bech32 excludes `1` from the data charset
    // precisely so it can mark the end of the human-readable part. Splitting on
    // the first one instead would cut `lnbc210n1p…` (210 nano-BTC) in half.
    let sep = after_prefix.rfind('1').ok_or("invoice has no separator")?;
    let (amount, data) = (&after_prefix[..sep], &after_prefix[sep + 1..]);

    // Amount is optional: digits, then an optional milli/micro/nano/pico suffix.
    if !amount.is_empty() {
        let digits = amount.strip_suffix(['m', 'u', 'n', 'p']).unwrap_or(amount);
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return Err("malformed invoice amount".into());
        }
    }

    // Bech32 data charset: `1`, `b`, `i` and `o` are excluded by design.
    if data.len() < 20 || !data.chars().all(|c| "023456789acdefghjklmnpqrstuvwxyz".contains(c)) {
        return Err("invoice data is not bech32".into());
    }
    Ok(format!("lightning:{payload}"))
}

/// Open a BOLT-11 invoice in the user's Lightning wallet.
#[tauri::command]
pub fn open_lightning(uri: String) -> Result<(), String> {
    let safe = validate_lightning(&uri)?;
    launch(&safe)
}

#[cfg(test)]
mod tests {
    use super::{validate, validate_lightning};

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

    /// A real mainnet invoice body, truncated to the shape the validator checks.
    const DATA: &str = "pp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq";

    #[test]
    fn accepts_invoices_with_and_without_an_amount() {
        for good in [
            format!("lightning:lnbc1{DATA}"),
            format!("lightning:lnbc210n1{DATA}"),
            format!("lightning:lnbc2500u1{DATA}"),
            format!("lightning:lntb20m1{DATA}"),
            format!("lightning:lnbcrt1{DATA}"),
            // Uppercase is what a QR code carries; bech32 is case-insensitive.
            format!("LIGHTNING:LNBC210N1{}", DATA.to_uppercase()),
        ] {
            assert!(validate_lightning(&good).is_ok(), "should accept {good}");
        }
    }

    #[test]
    fn normalizes_to_a_lowercase_lightning_uri() {
        let out = validate_lightning(&format!("  LIGHTNING:LNBC210N1{}  ", DATA.to_uppercase())).unwrap();
        assert_eq!(out, format!("lightning:lnbc210n1{DATA}"));
    }

    /// The amount's own digits can contain `1`, so the split has to anchor on
    /// the LAST one. Splitting on the first would leave `0n1…` as the data part.
    #[test]
    fn splits_on_the_last_separator_not_the_first() {
        assert!(validate_lightning(&format!("lightning:lnbc210n1{DATA}")).is_ok());
    }

    #[test]
    fn rejects_everything_that_is_not_an_invoice() {
        for bad in [
            "https://example.com".to_string(),
            "file:///etc/passwd".to_string(),
            "lightning:".to_string(),
            // Another scheme wearing the prefix.
            format!("lightning:javascript:alert(1){DATA}"),
            // LNURL and lightning addresses are not payable by this door.
            "lightning:lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7".to_string(),
            "lightning:alice@example.com".to_string(),
            // Right prefix, data too short to be an invoice.
            "lightning:lnbc1pp5qq".to_string(),
            // `b`, `i`, `o` are not in the bech32 charset.
            format!("lightning:lnbc1{}", "b".repeat(30)),
            // Amount that isn't a number.
            format!("lightning:lnbcxyz1{DATA}"),
            format!("lightning:lnbc\n210n1{DATA}"),
        ] {
            assert!(validate_lightning(&bad).is_err(), "should reject {bad}");
        }
    }
}
