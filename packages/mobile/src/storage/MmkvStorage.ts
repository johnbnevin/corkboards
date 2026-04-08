/**
 * MMKV-backed KVStorage implementation for React Native.
 *
 * MMKV is synchronous and fast (backed by mmap), so both sync
 * and async methods are available immediately — no warm-up needed.
 */
import { MMKV } from 'react-native-mmkv';
import type { KVStorage } from '@core/storage';

const mmkv = new MMKV();

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
