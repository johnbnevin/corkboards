/**
 * Shared AES-256-GCM encryption utilities for Nostr event encryption.
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
 */
export async function encryptForSelf(
  plaintext: string,
  signer: { nip44?: { encrypt(pubkey: string, plaintext: string): Promise<string> }; nip04?: { encrypt(pubkey: string, plaintext: string): Promise<string> } },
  pubkey: string,
): Promise<{ content: string; wrappedKey: string; signerMethod: 'nip44' | 'nip04' }> {
  const { raw, key } = await generateAesKey();
  const encrypted = await aesEncrypt(key, plaintext);
  const keyHex = rawKeyToHex(raw);

  // Wrap AES key via signer (prefer NIP-44, fallback NIP-04)
  let wrappedKey: string;
  let signerMethod: 'nip44' | 'nip04';
  try {
    wrappedKey = await signer.nip44!.encrypt(pubkey, keyHex);
    signerMethod = 'nip44';
  } catch {
    wrappedKey = await signer.nip04!.encrypt(pubkey, keyHex);
    signerMethod = 'nip04';
  }

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
  const keyHex = signerMethod === 'nip04'
    ? await signer.nip04!.decrypt(pubkey, wrappedKey)
    : await signer.nip44!.decrypt(pubkey, wrappedKey);

  const raw = hexToRawKey(keyHex);
  const aesKey = await importAesKey(raw);
  return aesDecrypt(aesKey, content);
}
