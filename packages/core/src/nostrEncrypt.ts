/**
 * Shared AES-256-GCM encryption utilities for Nostr event encryption.
 *
 * Single source of truth for web + mobile (both re-export this via
 * `@core/nostrEncrypt`). It was hand-duplicated in each app before, which is how
 * it drifted — the same one-line fix had to be applied twice. It needs no
 * DOM/React and is testable directly under `test:core`.
 *
 * ⚠ PLATFORM PREREQUISITE: this module assumes the runtime provides WebCrypto
 * (`crypto.subtle`, `crypto.getRandomValues`), `TextEncoder`/`TextDecoder` and
 * `btoa`/`atob` as globals. Browsers and Node ≥ 16 do. **React Native / Hermes
 * does NOT ship `crypto.subtle`** — the app must install a polyfill at startup,
 * before anything imports this, or every call here throws at the first
 * `crypto.subtle.…`. Do not "fix" a failure by falling back to a hand-rolled
 * cipher; a missing polyfill is a startup bug, not a reason to weaken the
 * encryption protecting the user's backup.
 *
 * Used by:
 * - useNostrBackup.ts (full settings backup)
 * - useNostrCustomFeedsSync.ts (kind 35571 corkboard sync)
 * - useNostrDismissedSync.ts (kind 35572 dismissed notes sync)
 */

export async function generateAesKey(): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { raw, key };
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as ArrayBufferView<ArrayBuffer>, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return uint8ToBase64(combined);
}

export async function aesDecrypt(key: CryptoKey, data: string): Promise<string> {
  const combined = base64ToUint8(data);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/** Convert raw AES key bytes to hex string for wrapping via NIP-44/NIP-04. */
export function rawKeyToHex(raw: Uint8Array): string {
  return Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Convert hex string back to raw AES key bytes. */
export function hexToRawKey(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex: odd length');
  // parseInt('1g', 16) returns 1, not NaN, so the per-nibble isNaN check below
  // silently accepts a wrong byte. Reject non-hex up front instead.
  if (!/^[0-9a-f]*$/i.test(hex)) throw new Error('Invalid hex: non-hex characters');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) throw new Error(`Invalid hex character at position ${i}`);
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Encrypt a JSON payload for self-storage on Nostr.
 * Returns the encrypted content string and tags needed for the event.
 *
 * NIP-44 v2 only — we never request a version explicitly, but @nostrify
 * signers (NSecSigner, NConnectSigner) negotiate v2 with no v1 downgrade
 * path. NIP-04 is only used to *unwrap* legacy own-data sync events that
 * were written before this codebase moved to NIP-44; new writes always go
 * through `nip44.encrypt`. This applies to backup, custom-feed, and
 * dismissed-notes sync only — DMs are pure NIP-17 after the kind-4 removal
 * in cypherpunk Phase 1.
 */
export async function encryptForSelf(
  plaintext: string,
  signer: { nip44?: { encrypt(pubkey: string, plaintext: string): Promise<string> }; nip04?: { encrypt(pubkey: string, plaintext: string): Promise<string> } },
  pubkey: string,
): Promise<{ content: string; wrappedKey: string; signerMethod: 'nip44' | 'nip04' }> {
  const { raw, key } = await generateAesKey();
  const encrypted = await aesEncrypt(key, plaintext);
  const keyHex = rawKeyToHex(raw);

  // NIP-44 v2 only on the write path. No silent downgrade to deprecated NIP-04
  // in a catch: a transient nip44 failure (a dismissed NIP-46 prompt, a signer
  // timeout) is retryable and must surface — quietly persisting a weaker NIP-04
  // wrap and publicly tagging it 'nip04' is exactly the "less-private fallback
  // needs consent, not a catch block" anti-pattern. NIP-04 stays on the *decrypt*
  // side below, only to unwrap legacy events written before this migration.
  if (!signer.nip44) throw new Error('Signer does not support NIP-44 encryption');
  const wrappedKey = await signer.nip44.encrypt(pubkey, keyHex);
  const signerMethod: 'nip44' | 'nip04' = 'nip44';

  return { content: encrypted, wrappedKey, signerMethod };
}

/**
 * Decrypt a self-encrypted Nostr event payload.
 */
export async function decryptFromSelf(
  content: string,
  wrappedKey: string,
  signerMethod: 'nip44' | 'nip04',
  signer: { nip44?: { decrypt(pubkey: string, ciphertext: string): Promise<string> }; nip04?: { decrypt(pubkey: string, ciphertext: string): Promise<string> } },
  pubkey: string,
): Promise<string> {
  // Explicit checks rather than `!`: a signer without the method the event was
  // written with is a real, reachable state (a NIP-07 extension or a NIP-46
  // remote signer may implement only NIP-44), and the assertion turned it into
  // an opaque "cannot read properties of undefined" instead of something the UI
  // can tell the user about.
  let keyHex: string;
  if (signerMethod === 'nip04') {
    if (!signer.nip04) {
      throw new Error('Signer does not support NIP-04 (required to decrypt this legacy event)');
    }
    keyHex = await signer.nip04.decrypt(pubkey, wrappedKey);
  } else {
    if (!signer.nip44) throw new Error('Signer does not support NIP-44 decryption');
    keyHex = await signer.nip44.decrypt(pubkey, wrappedKey);
  }

  const raw = hexToRawKey(keyHex);
  const aesKey = await importAesKey(raw);
  return aesDecrypt(aesKey, content);
}
