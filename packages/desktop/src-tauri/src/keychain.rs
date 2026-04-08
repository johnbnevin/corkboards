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
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// Retrieve a secret from the OS keychain.
#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret from the OS keychain.
#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    validate_key(&key)?;
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
        Err(e) => Err(e.to_string()),
    }
}
