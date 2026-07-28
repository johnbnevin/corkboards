/**
 * WebCrypto `subtle` polyfill for React Native / Hermes.
 *
 * ## Why this exists
 *
 * Hermes ships no WebCrypto at all, and `react-native-get-random-values` — the
 * app's only crypto polyfill — installs exactly ONE member:
 *
 *     if (typeof global.crypto.getRandomValues !== 'function') {
 *       global.crypto.getRandomValues = getRandomValues
 *     }
 *
 * There is no `crypto.subtle` and no `crypto.randomUUID` behind it.
 *
 * Every encrypted-backup path on mobile goes through `@core/nostrEncrypt`
 * (`generateAesKey` / `aesEncrypt` / `aesDecrypt`, all `crypto.subtle.*`), and
 * every Blossom integrity check goes through `crypto.subtle.digest('SHA-256')`.
 * On device each of those threw `TypeError: undefined is not an object
 * (evaluating 'crypto.subtle.generateKey')` — and because those call sites sit
 * inside `catch` blocks that degrade quietly, the user saw "Backup failed" or
 * nothing at all rather than "this device cannot encrypt". Cloud backup,
 * corkboard sync, dismissed-note sync and blob-hash verification were all
 * silently dead. A backup the user believes exists and does not is precisely
 * the failure mode this project treats as unacceptable.
 *
 * ## What it implements
 *
 * Only the subset the app actually calls, on top of the audited @noble
 * primitives nostr-tools already depends on for NIP-44 — no native module, no
 * new build step:
 *
 *   - `digest('SHA-256' | 'SHA-512', data)`
 *   - `generateKey` / `importKey('raw')` / `exportKey('raw')` for AES-GCM
 *   - `encrypt` / `decrypt` for AES-GCM with a 128-bit tag appended to the
 *     ciphertext — byte-identical to what browser WebCrypto produces, so a
 *     backup blob written on a phone still decrypts on web and desktop.
 *
 * Anything outside that surface throws a `NotSupportedError` rather than
 * returning something plausible: a crypto shim that guesses is worse than one
 * that stops. Callers that hit it should be fixed, not caught.
 *
 * Feature-detected throughout, so this becomes a no-op the moment the runtime
 * (or Expo) ships real WebCrypto. Credit: @paulmillr's noble-ciphers /
 * noble-hashes, the same libraries fiatjaf's nostr-tools uses.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { randomUuid } from '@core/cryptoUtils';

const AES_GCM = 'AES-GCM';
/** @noble's `gcm` is fixed at the standard 128-bit auth tag, as is our usage. */
const SUPPORTED_TAG_LENGTH = 128;

/** Internal AES key handle. Structurally a CryptoKey plus the raw bytes. */
interface ShimAesKey {
  readonly type: 'secret';
  readonly extractable: boolean;
  readonly algorithm: { name: typeof AES_GCM; length: number };
  readonly usages: readonly KeyUsage[];
  readonly rawKeyBytes: Uint8Array;
}

function notSupported(what: string): never {
  const err = new Error(`[webcrypto] ${what} is not supported by the React Native WebCrypto shim`);
  err.name = 'NotSupportedError';
  throw err;
}

function algorithmName(algorithm: AlgorithmIdentifier): string {
  return (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
}

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/** Copy into a standalone ArrayBuffer — never hand out a view over @noble scratch. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function asShimKey(key: CryptoKey): ShimAesKey {
  const candidate = key as unknown as Partial<ShimAesKey>;
  if (!candidate || !(candidate.rawKeyBytes instanceof Uint8Array)) {
    notSupported('a CryptoKey that was not produced by this shim');
  }
  return candidate as ShimAesKey;
}

function makeKey(raw: Uint8Array, extractable: boolean, usages: readonly KeyUsage[]): CryptoKey {
  const key: ShimAesKey = {
    type: 'secret',
    extractable,
    algorithm: { name: AES_GCM, length: raw.length * 8 },
    usages: [...usages],
    rawKeyBytes: raw,
  };
  return key as unknown as CryptoKey;
}

/** Validate the AES-GCM params and return the pieces @noble needs. */
function gcmParams(algorithm: AlgorithmIdentifier): { iv: Uint8Array; aad?: Uint8Array } {
  const name = algorithmName(algorithm);
  if (name !== AES_GCM) notSupported(`cipher ${name}`);
  const params = algorithm as AesGcmParams;
  if (!params.iv) notSupported('AES-GCM without an iv');
  if (params.tagLength !== undefined && params.tagLength !== SUPPORTED_TAG_LENGTH) {
    notSupported(`AES-GCM tagLength ${params.tagLength}`);
  }
  return {
    iv: toBytes(params.iv),
    aad: params.additionalData ? toBytes(params.additionalData) : undefined,
  };
}

function createSubtleShim(): SubtleCrypto {
  const subtle = {
    async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
      const name = algorithmName(algorithm);
      const bytes = toBytes(data);
      if (name === 'SHA-256') return toArrayBuffer(sha256(bytes));
      if (name === 'SHA-512') return toArrayBuffer(sha512(bytes));
      return notSupported(`digest(${name})`);
    },

    async generateKey(
      algorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: readonly KeyUsage[],
    ): Promise<CryptoKey> {
      const name = algorithmName(algorithm);
      if (name !== AES_GCM) notSupported(`generateKey(${name})`);
      const length = (algorithm as AesKeyGenParams).length ?? 256;
      if (length !== 128 && length !== 192 && length !== 256) {
        notSupported(`AES-GCM key length ${length}`);
      }
      const raw = new Uint8Array(length / 8);
      // Deliberately reads the live global: `react-native-get-random-values`
      // installs getRandomValues on the same object, possibly after this module
      // was evaluated. Never fall back to Math.random here — a predictable AES
      // key would silently destroy the confidentiality of every backup.
      if (typeof globalThis.crypto?.getRandomValues !== 'function') {
        throw new Error('[webcrypto] crypto.getRandomValues is unavailable — refusing to generate a key');
      }
      globalThis.crypto.getRandomValues(raw);
      return makeKey(raw, extractable, keyUsages);
    },

    async importKey(
      format: string,
      keyData: BufferSource,
      algorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: readonly KeyUsage[],
    ): Promise<CryptoKey> {
      if (format !== 'raw') notSupported(`importKey(format=${format})`);
      const name = algorithmName(algorithm);
      if (name !== AES_GCM) notSupported(`importKey(${name})`);
      const raw = toBytes(keyData);
      if (raw.length !== 16 && raw.length !== 24 && raw.length !== 32) {
        notSupported(`AES-GCM key of ${raw.length} bytes`);
      }
      // Copy: the caller may reuse or zero its buffer.
      return makeKey(Uint8Array.from(raw), extractable, keyUsages);
    },

    async exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer> {
      if (format !== 'raw') notSupported(`exportKey(format=${format})`);
      const shimKey = asShimKey(key);
      if (!shimKey.extractable) {
        const err = new Error('[webcrypto] key is not extractable');
        err.name = 'InvalidAccessError';
        throw err;
      }
      return toArrayBuffer(shimKey.rawKeyBytes);
    },

    async encrypt(
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      data: BufferSource,
    ): Promise<ArrayBuffer> {
      const { iv, aad } = gcmParams(algorithm);
      const shimKey = asShimKey(key);
      return toArrayBuffer(gcm(shimKey.rawKeyBytes, iv, aad).encrypt(toBytes(data)));
    },

    async decrypt(
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      data: BufferSource,
    ): Promise<ArrayBuffer> {
      const { iv, aad } = gcmParams(algorithm);
      const shimKey = asShimKey(key);
      // @noble throws on tag mismatch, which is what WebCrypto does too — an
      // OperationError. Let it propagate: a failed auth tag means the blob was
      // altered and must never be treated as plaintext.
      return toArrayBuffer(gcm(shimKey.rawKeyBytes, iv, aad).decrypt(toBytes(data)));
    },
  };

  return subtle as unknown as SubtleCrypto;
}

/**
 * True when the runtime can actually perform the operations the app depends on.
 *
 * Checked at startup (App.tsx) so a device without them gets a visible warning
 * instead of a stream of swallowed "Backup failed" messages.
 */
export function hasWebCryptoSubtle(): boolean {
  const c = globalThis.crypto as Crypto | undefined;
  return (
    typeof c?.getRandomValues === 'function' &&
    typeof c.subtle?.digest === 'function' &&
    typeof c.subtle?.encrypt === 'function' &&
    typeof c.subtle?.decrypt === 'function' &&
    typeof c.subtle?.generateKey === 'function' &&
    typeof c.subtle?.importKey === 'function' &&
    typeof c.subtle?.exportKey === 'function'
  );
}

/**
 * Install `crypto.subtle` (and `crypto.randomUUID`) if the runtime lacks them.
 *
 * Idempotent, and never overwrites a real implementation — on any runtime that
 * already has WebCrypto (Node under jest, a future Hermes) this does nothing.
 */
export function installWebCrypto(): void {
  const existing = globalThis.crypto as (Crypto & { subtle?: SubtleCrypto }) | undefined;

  if (!existing) {
    // No crypto object at all. Define one; `react-native-get-random-values`
    // will fill in getRandomValues on this same object afterwards (it only
    // creates `global.crypto` when the property is missing entirely).
    Object.defineProperty(globalThis, 'crypto', {
      value: { subtle: createSubtleShim() },
      configurable: true,
      writable: true,
    });
  } else if (typeof existing.subtle?.encrypt !== 'function') {
    try {
      (existing as { subtle?: SubtleCrypto }).subtle = createSubtleShim();
    } catch {
      // Frozen or accessor-only `crypto` — replace the global with a wrapper
      // that forwards getRandomValues to the original implementation.
      const getRandomValues = existing.getRandomValues?.bind(existing);
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues, subtle: createSubtleShim() },
        configurable: true,
        writable: true,
      });
    }
  }

  // `crypto.randomUUID` is absent for the same reason `subtle` is. Core code
  // deliberately avoids it (see @core/cryptoUtils.randomUuid), but third-party
  // libraries reach for it, and an absent member is a crash rather than a
  // degraded path. Back it with the same getRandomValues-only implementation.
  const cryptoObj = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID !== 'function') {
    try {
      cryptoObj.randomUUID = randomUuid as () => `${string}-${string}-${string}-${string}-${string}`;
    } catch { /* non-writable — callers should use @core/cryptoUtils anyway */ }
  }
}
