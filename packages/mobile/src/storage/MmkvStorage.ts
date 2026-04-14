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
    mmkv.set(key, value);
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
    mmkv.set(key, value);
  },
  removeSync(key: string): void {
    mmkv.delete(key);
  },

  // MMKV is ready immediately — no async init needed
  ready: Promise.resolve(),
};
