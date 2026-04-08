/**
 * Platform-agnostic key-value storage interface.
 *
 * Web: wraps IndexedDB (idb.ts)
 * Tauri: IndexedDB or tauri-plugin-store
 * React Native: MMKV
 */
export interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  getAll(): Promise<Map<string, string>>;

  /** Sync access from in-memory cache. Available after `ready` resolves. */
  getSync(key: string): string | null;
  setSync(key: string, value: string): void;
  removeSync(key: string): void;

  /** Resolves when the storage backend is initialized and sync access is available. */
  readonly ready: Promise<void>;
}
