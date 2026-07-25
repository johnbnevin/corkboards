/**
 * MMKV-backed KVStorage implementation for React Native.
 *
 * MMKV is synchronous and fast (backed by mmap), so both sync and async
 * methods are available immediately — no warm-up needed.
 *
 * Cypherpunk note: the active MMKV instance is *encrypted* with a 32-byte
 * key derived once per device and stored in the OS keychain (Keychain on
 * iOS, Keystore on Android) via react-native-keychain. The encryption key
 * never touches disk in cleartext, and rooting/jailbreaking the device is
 * required to extract it. This protects DM history, backup metadata, and
 * relay routing from offline attackers who acquire a backup of the
 * device's filesystem.
 *
 * Bootstrap order:
 *   1. App.tsx awaits {@link prepareSecureStorage} before rendering.
 *   2. That call retrieves (or generates+stores) the encryption key.
 *   3. The encrypted MMKV instance is opened; any data from the legacy
 *      unencrypted instance is migrated once, then the legacy instance is
 *      cleared.
 *   4. Sync consumers (mobileStorage.getSync/setSync) work as before.
 *
 * If keychain access fails (locked device, simulator with no keychain),
 * we fall back to the legacy unencrypted instance and surface the failure
 * via {@link mmkvInitError} so the UI can warn the user.
 */
import { createMMKV, type MMKV } from 'react-native-mmkv';
import * as Keychain from 'react-native-keychain';
import type { KVStorage } from '@core/storage';

const KEYCHAIN_SERVICE = 'me.corkboards.mmkv';
const KEYCHAIN_USERNAME = 'mmkv-encryption-key';
const ENCRYPTED_INSTANCE_ID = 'corkboards-encrypted';
const LEGACY_INSTANCE_ID = 'corkboards-default';
const MIGRATION_FLAG = '__mmkv_migrated_from_legacy__';

let mmkv: MMKV;
/** Resolved encryption key (hex) once prepareSecureStorage settles, or null on fallback. */
let _resolvedEncryptionKey: string | null = null;
/** True if MMKV failed to initialize and we're using in-memory fallback (data will not persist). */
export let mmkvInitFailed = false;
/** Error message from MMKV init failure (for user-facing display). */
export let mmkvInitError: string | null = null;
/** True if storage is encrypted with a keychain-backed key. False indicates fallback. */
export let mmkvIsEncrypted = false;

/**
 * Open an additional MMKV shard encrypted with the same keychain-backed key
 * as the main store. Must be awaited *after* prepareSecureStorage() resolves.
 * If encryption setup failed, returns a plain unencrypted MMKV (matching the
 * main store's degraded mode).
 */
export async function openEncryptedShard(id: string): Promise<MMKV> {
  await prepareSecureStorage();
  if (_resolvedEncryptionKey) {
    return createMMKV({ id, encryptionKey: _resolvedEncryptionKey });
  }
  return createMMKV({ id });
}

// ─── Persistence health tracking (parity with web's isIdbHealthy) ───────────
let consecutiveWriteFailures = 0;
const MAX_WRITE_FAILURES_BEFORE_UNHEALTHY = 3;

/** Returns true if storage writes are succeeding. Auto-save should check this. */
export function isStorageHealthy(): boolean {
  return !mmkvInitFailed && consecutiveWriteFailures < MAX_WRITE_FAILURES_BEFORE_UNHEALTHY;
}

/**
 * Generate the MMKV encryption key.
 *
 * MMKV caps the encryption key at 16 bytes and silently truncates anything
 * longer to its first 16 bytes. The previous key was a 64-char hex string, so
 * MMKV saw only its first 16 ASCII hex chars = 8 bytes = 64 bits of real
 * entropy. This generates a proper 16-byte key as 16 printable-ASCII characters
 * (each a single UTF-8 byte, ~6.5 bits each → ~105 bits total), which is MMKV's
 * documented correct usage and puts entropy in every one of the 16 bytes.
 *
 * Existing installs keep whatever key is already in their keychain (it is read
 * and used as-is below), so this changes new installs only — no re-keying and no
 * data loss for anyone already running. Uses crypto.getRandomValues, polyfilled
 * by react-native-get-random-values in App.tsx.
 */
function generateEncryptionKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Map each byte into printable ASCII 33..126 so the string is reliably 16
  // single-byte characters (no multi-byte UTF-8 that would change the length).
  return Array.from(bytes).map(b => String.fromCharCode(33 + (b % 94))).join('');
}

/**
 * Bootstrap secure storage. Must be awaited before any consumer calls
 * mobileStorage.getSync / setSync. Idempotent — safe to call multiple times.
 *
 * Strategy:
 *   1. Try to load encryption key from keychain.
 *   2. If absent, generate a fresh 32-byte key, store it, open encrypted MMKV.
 *   3. If a legacy unencrypted instance exists, migrate its data once.
 *   4. On any failure, fall back to unencrypted MMKV and set mmkvInitError.
 */
let _prepareDone: Promise<void> | null = null;
export function prepareSecureStorage(): Promise<void> {
  if (_prepareDone) return _prepareDone;
  _prepareDone = (async () => {
    try {
      let key: string | null = null;
      let keychainReadErrored = false;
      // 1) Try to retrieve existing key from keychain.
      try {
        const creds = await Keychain.getGenericPassword({
          service: KEYCHAIN_SERVICE,
        });
        if (creds && typeof creds !== 'boolean') {
          key = creds.password;
        }
      } catch (e) {
        keychainReadErrored = true;
        console.warn('[MmkvStorage] Keychain read failed:', e);
      }

      // CRITICAL: never regenerate a key we merely FAILED to read. Generating a
      // fresh key here would open MMKV with the wrong key and orphan every
      // existing encrypted record — permanent data loss from a transient keychain
      // hiccup (locked device, dismissed biometry prompt). If the read errored and
      // returned nothing, bail into the degraded fallback below WITHOUT touching
      // the stored key or the encrypted instance, so the data survives until the
      // keychain recovers on a later launch. The user is warned via mmkvInitError.
      if (keychainReadErrored && !key) {
        throw new Error('Keychain temporarily unavailable — not regenerating the key (would orphan encrypted data). Will retry next launch.');
      }

      // 2) Only when the keychain genuinely holds no key (first run) do we create
      //    one. A key that IS present is used as-is regardless of format:
      //    second-guessing a stored key's length and regenerating is the same
      //    data-loss trap as regenerating on a read error.
      if (!key) {
        key = generateEncryptionKey();
        await Keychain.setGenericPassword(KEYCHAIN_USERNAME, key, {
          service: KEYCHAIN_SERVICE,
          // Encrypt at rest with iOS/Android secure hardware where available.
          accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      }

      // 3) Open encrypted instance.
      mmkv = createMMKV({ id: ENCRYPTED_INSTANCE_ID, encryptionKey: key });
      mmkvIsEncrypted = true;
      _resolvedEncryptionKey = key;

      // 4) One-time migration from the legacy unencrypted instance.
      if (!mmkv.getString(MIGRATION_FLAG)) {
        try {
          const legacy = createMMKV({ id: LEGACY_INSTANCE_ID });
          const legacyKeys = legacy.getAllKeys();
          if (legacyKeys.length > 0) {
            if (__DEV__) console.log(`[MmkvStorage] Migrating ${legacyKeys.length} keys from legacy unencrypted MMKV...`);
            for (const k of legacyKeys) {
              const v = legacy.getString(k);
              if (v !== undefined) mmkv.set(k, v);
            }
            // Clear legacy after successful migration so cleartext copies
            // don't linger on disk.
            legacy.clearAll();
          }
          mmkv.set(MIGRATION_FLAG, '1');
        } catch (e) {
          console.warn('[MmkvStorage] Legacy migration skipped:', e);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[MmkvStorage] Encrypted init failed, falling back to unencrypted:', msg);
      mmkvInitError = `Storage encryption setup failed: ${msg}. Data persists but is not encrypted at rest.`;
      // Fall back to plain MMKV so the app can still launch.
      try {
        mmkv = createMMKV({ id: LEGACY_INSTANCE_ID });
        mmkvIsEncrypted = false;
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        console.error('[MmkvStorage] Plain MMKV init also failed:', msg2);
        mmkvInitFailed = true;
        mmkvInitError = `Storage initialization failed: ${msg2}. Data will not persist across restarts.`;
        const fallback = new Map<string, string>();
        mmkv = {
          getString: (k: string) => fallback.get(k),
          set: (k: string, v: string) => { fallback.set(k, v); },
          remove: (k: string) => fallback.delete(k),
          clearAll: () => { fallback.clear(); },
          getAllKeys: () => [...fallback.keys()],
        } as unknown as MMKV;
      }
    }
  })();
  return _prepareDone;
}

// Eagerly start init so consumers that depend on `mobileStorage.ready` get
// a settled promise without having to call prepareSecureStorage themselves.
// The App.tsx splash still awaits this before unmounting; any code path that
// runs before the splash clears uses MMKV that may not yet be ready.
//
// To avoid a sync-vs-async race we open a *temporary* legacy instance
// synchronously so module-eval-time reads don't crash. The real encrypted
// instance replaces it as soon as prepareSecureStorage() resolves.
try {
  mmkv = createMMKV({ id: LEGACY_INSTANCE_ID });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[MmkvStorage] Synchronous bootstrap failed:', msg);
  mmkvInitFailed = true;
  mmkvInitError = `Storage initialization failed: ${msg}. Data will not persist across restarts.`;
  const fallback = new Map<string, string>();
  mmkv = {
    getString: (k: string) => fallback.get(k),
    set: (k: string, v: string) => { fallback.set(k, v); },
    remove: (k: string) => fallback.delete(k),
    clearAll: () => { fallback.clear(); },
    getAllKeys: () => [...fallback.keys()],
  } as unknown as MMKV;
}
// Start the async upgrade in the background; App.tsx awaits its promise.
prepareSecureStorage();

export const mobileStorage: KVStorage = {
  // Async methods (delegate to sync — MMKV is already synchronous)
  async get(key: string): Promise<string | null> {
    return mmkv.getString(key) ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    try {
      mmkv.set(key, value);
      consecutiveWriteFailures = 0;
    } catch (err) {
      consecutiveWriteFailures++;
      if (consecutiveWriteFailures === MAX_WRITE_FAILURES_BEFORE_UNHEALTHY) {
        console.error('[MmkvStorage] Persistence unhealthy — writes failing repeatedly. Auto-save will pause to protect cloud backups.');
      }
      throw err;
    }
  },
  async remove(key: string): Promise<void> {
    mmkv.remove(key);
  },
  async clear(): Promise<void> {
    mmkv.clearAll();
  },
  async keys(): Promise<string[]> {
    return mmkv.getAllKeys();
  },
  async getAll(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const key of mmkv.getAllKeys()) {
      const value = mmkv.getString(key);
      if (value !== undefined) map.set(key, value);
    }
    return map;
  },

  // Sync methods (direct MMKV access)
  getSync(key: string): string | null {
    return mmkv.getString(key) ?? null;
  },
  // MMKV reads hit the real store, so existence is always exactly known — no
  // cache layer can make a present key look absent the way web's IndexedDB
  // memCache can. Implemented anyway so the core helpers get the authoritative
  // answer on every platform rather than falling back to their conservative
  // "don't delete when unsure" path. See KVStorage.hasSync in @core/storage.
  hasSync(key: string): boolean {
    return mmkv.getString(key) !== undefined;
  },
  setSync(key: string, value: string): void {
    try {
      mmkv.set(key, value);
      consecutiveWriteFailures = 0;
    } catch (err) {
      consecutiveWriteFailures++;
      if (consecutiveWriteFailures === MAX_WRITE_FAILURES_BEFORE_UNHEALTHY) {
        console.error('[MmkvStorage] Persistence unhealthy — writes failing repeatedly. Auto-save will pause to protect cloud backups.');
      }
      throw err;
    }
  },
  removeSync(key: string): void {
    mmkv.remove(key);
  },

  // Ready when secure-key bootstrap completes.
  ready: prepareSecureStorage(),
};
