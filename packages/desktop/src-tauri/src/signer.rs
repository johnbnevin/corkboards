//! Rust-side Nostr signing & NIP-04/44 encryption.
//!
//! Keeps the user's nsec OUT of the JS layer: the secret key is read from the OS
//! keychain (`nsec:<pubkey>`), used in-process, and never returned across the IPC
//! boundary. The web frontend's nsec signer (on desktop only) delegates to these
//! commands instead of holding the key in JS memory.
//!
//! Scope: `nsec` logins on desktop only. Bunker (NIP-46) and extension logins
//! already keep the key out of the app; web/mobile sign in JS (no Rust backend).
//! The crypto comes from the spec-compliant `nostr` crate, so output is
//! byte-compatible with the JS `@nostrify`/nostr-tools implementations.

use nostr::prelude::*;
use serde_json::Value;

use crate::keychain;

/// Load the signing `Keys` for a pubkey from the keychain entry `nsec:<pubkey>`.
fn keys_for(pubkey: &str) -> Result<Keys, String> {
    let nsec = keychain::get_secret(&format!("nsec:{pubkey}"))?
        .ok_or_else(|| "no key in keychain for this pubkey".to_string())?;
    Keys::parse(&nsec).map_err(|_| "stored key is not a valid nsec".to_string())
}

/// Sign an unsigned event template `{ kind, content, tags, created_at? }` and
/// return the full signed event JSON (with `id`, `pubkey`, `sig`).
#[tauri::command]
pub fn sign_event(pubkey: String, unsigned: Value) -> Result<Value, String> {
    let keys = keys_for(&pubkey)?;

    // Nostr kinds are 0..=65535 (NIP-01). Reject an out-of-range kind rather than
    // truncating with `as u16`: 65536 would silently sign as kind 0, an event
    // different from what the caller asked for.
    let kind_u64 = unsigned
        .get("kind")
        .and_then(|v| v.as_u64())
        .ok_or("missing kind")?;
    if kind_u64 > u16::MAX as u64 {
        return Err(format!("kind {kind_u64} out of range (0..=65535)"));
    }
    let kind = kind_u64 as u16;
    let content = unsigned
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut tags: Vec<Tag> = Vec::new();
    if let Some(arr) = unsigned.get("tags").and_then(|v| v.as_array()) {
        for t in arr {
            // Reject a non-string tag element rather than silently dropping it:
            // signing a tag array that differs from what the caller sent means the
            // id/sig cover data the caller never approved.
            let inner = t.as_array().ok_or("tag is not an array")?;
            let mut parts: Vec<String> = Vec::with_capacity(inner.len());
            for x in inner {
                let s = x.as_str().ok_or("tag element is not a string")?;
                parts.push(s.to_string());
            }
            if !parts.is_empty() {
                tags.push(Tag::parse(parts).map_err(|e| format!("bad tag: {e}"))?);
            }
        }
    }

    let ts = match unsigned.get("created_at").and_then(|v| v.as_u64()) {
        Some(secs) => Timestamp::from_secs(secs),
        None => Timestamp::now(),
    };

    let event = UnsignedEvent::new(keys.public_key(), ts, Kind::from(kind), tags, content)
        .sign_with_keys(&keys)
        .map_err(|e| format!("sign: {e}"))?;

    serde_json::from_str(&event.as_json()).map_err(|e| format!("serialize: {e}"))
}

/// NIP-44 (v2) encrypt `plaintext` to `peer_pubkey` using the keychain key.
#[tauri::command]
pub fn nip44_encrypt(pubkey: String, peer_pubkey: String, plaintext: String) -> Result<String, String> {
    let keys = keys_for(&pubkey)?;
    let peer = PublicKey::parse(&peer_pubkey).map_err(|_| "invalid peer pubkey".to_string())?;
    nostr::nips::nip44::encrypt(keys.secret_key(), &peer, plaintext, nostr::nips::nip44::Version::V2)
        .map_err(|e| format!("nip44 encrypt: {e}"))
}

/// NIP-44 decrypt `ciphertext` from `peer_pubkey` using the keychain key.
#[tauri::command]
pub fn nip44_decrypt(pubkey: String, peer_pubkey: String, ciphertext: String) -> Result<String, String> {
    let keys = keys_for(&pubkey)?;
    let peer = PublicKey::parse(&peer_pubkey).map_err(|_| "invalid peer pubkey".to_string())?;
    nostr::nips::nip44::decrypt(keys.secret_key(), &peer, ciphertext)
        .map_err(|e| format!("nip44 decrypt: {e}"))
}

/// NIP-04 encrypt (legacy — kept only for NWC and legacy own-data decryption).
#[tauri::command]
pub fn nip04_encrypt(pubkey: String, peer_pubkey: String, plaintext: String) -> Result<String, String> {
    let keys = keys_for(&pubkey)?;
    let peer = PublicKey::parse(&peer_pubkey).map_err(|_| "invalid peer pubkey".to_string())?;
    nostr::nips::nip04::encrypt(keys.secret_key(), &peer, plaintext)
        .map_err(|e| format!("nip04 encrypt: {e}"))
}

/// NIP-04 decrypt (legacy).
#[tauri::command]
pub fn nip04_decrypt(pubkey: String, peer_pubkey: String, ciphertext: String) -> Result<String, String> {
    let keys = keys_for(&pubkey)?;
    let peer = PublicKey::parse(&peer_pubkey).map_err(|_| "invalid peer pubkey".to_string())?;
    nostr::nips::nip04::decrypt(keys.secret_key(), &peer, ciphertext)
        .map_err(|e| format!("nip04 decrypt: {e}"))
}
