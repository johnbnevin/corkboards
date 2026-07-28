use keyring::Entry;

const SERVICE_NAME: &str = "me.corkboards.desktop";

/// Maximum allowed key length (prevents OS keychain API abuse and path-traversal-like inputs).
const MAX_KEY_LEN: usize = 256;

/// Maximum allowed value length — an nsec is ~63 chars; 64 KB is a generous ceiling.
const MAX_VALUE_LEN: usize = 65_536;

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("keychain key must not be empty".to_string());
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!("keychain key exceeds maximum length of {} bytes", MAX_KEY_LEN));
    }
    if !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b':' || b == b'_' || b == b'.') {
        return Err("keychain key must only contain ASCII alphanumeric characters, '-', ':', '_', or '.'".to_string());
    }
    Ok(())
}

/// Store a secret (nsec) in the OS keychain.
#[tauri::command]
pub fn keychain_store(key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    if value.len() > MAX_VALUE_LEN {
        return Err(format!("keychain value exceeds maximum length of {} bytes", MAX_VALUE_LEN));
    }
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|_| "Failed to access keychain".to_string())?;
    entry.set_password(&value).map_err(|_| "Failed to store keychain entry".to_string())
}

/// Internal: read a secret from the OS keychain by key. Used by the Rust signer
/// (`signer.rs`) so the secret can be used in-process without ever returning it
/// to JS. Intentionally NOT exposed as a `#[tauri::command]` — the webview must
/// never be able to `invoke()` a raw nsec read (an XSS could otherwise exfiltrate
/// the secret).
pub(crate) fn get_secret(key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    let entry = Entry::new(SERVICE_NAME, key).map_err(|_| "Failed to access keychain".to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Failed to retrieve keychain entry".to_string()),
    }
}

/// Whether the keychain holds an entry for `key`.
///
/// Safe to expose to the webview in a way `keychain_get` is not: it answers a
/// yes/no question and never returns key material, so an XSS learns only that
/// an account exists — which the login list already tells it.
///
/// This exists because a missing entry is otherwise INVISIBLE until the user
/// tries to post: `signer.rs` fails every sign/encrypt with "no key in keychain
/// for this pubkey" and the UI just looks broken. Users who stored a key under
/// the old volatile-keyutils Linux backend lost it on reboot and had no way to
/// tell that from a bug. The frontend calls this at startup so it can say
/// plainly that the key is gone and offer to re-import it.
#[tauri::command]
pub fn keychain_has(key: String) -> Result<bool, String> {
    Ok(get_secret(&key)?.is_some())
}

/// Delete a secret from the OS keychain.
#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    validate_key(&key)?;
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|_| "Failed to access keychain".to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
        Err(_) => Err("Failed to delete keychain entry".to_string()),
    }
}
