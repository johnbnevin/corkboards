/**
 * MMKV-backed KVStorage implementation for React Native.
 *
 * MMKV is synchronous and fast (backed by mmap), so both sync
 * and async methods are available immediately — no warm-up needed.
 */
import { MMKV } from 'react-native-mmkv';
import type { KVStorage } from '@core/storage';

let mmkv: MMKV;
/** True if MMKV failed to initialize and we're using in-memory fallback (data will not persist). */
export let mmkvInitFailed = false;
/** Error message from MMKV init failure (for user-facing display). */
export let mmkvInitError: string | null = null;

// ─── Persistence health tracking (parity with web's isIdbHealthy) ───────────
// Tracks consecutive write failures. When > 0, auto-save should avoid
// overwriting cloud backups because local data may not match disk.
let consecutiveWriteFailures = 0;
const MAX_WRITE_FAILURES_BEFORE_UNHEALTHY = 3;

/** Returns true if storage writes are succeeding. Auto-save should check this. */
export function isStorageHealthy(): boolean {
  return !mmkvInitFailed && consecutiveWriteFailures < MAX_WRITE_FAILURES_BEFORE_UNHEALTHY;
}

try {
  mmkv = new MMKV();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[MmkvStorage] Failed to initialize MMKV:', msg);
  mmkvInitFailed = true;
  mmkvInitError = `Storage initialization failed: ${msg}. Data will not persist across restarts.`;
  // Fallback: in-memory storage so the app can at least launch
  const fallback = new Map<string, string>();
  mmkv = {
    getString: (key: string) => fallback.get(key),
    set: (key: string, value: string) => { fallback.set(key, value); },
    delete: (key: string) => { fallback.delete(key); },
    clearAll: () => { fallback.clear(); },
    getAllKeys: () => [...fallback.keys()],
  } as unknown as MMKV;
}

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
    mmkv.delete(key);
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
    mmkv.delete(key);
  },

  // MMKV is ready immediately — no async init needed
  ready: Promise.resolve(),
};
