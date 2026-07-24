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

  /**
   * Whether `key` exists in the backing store — distinct from `getSync(key)
   * !== null`, which on a cache-backed implementation cannot tell "evicted"
   * from "absent".
   *
   * That difference is destructive, not cosmetic: `stashUserData` mirrors the
   * live keys into a per-account namespace and DELETES the stashed copy of any
   * key it reads as absent. Given a `getSync` that can miss, an account switch
   * silently discards the departing account's settings. Implementations that
   * can answer authoritatively should do so; the helpers in ./storageKeys.ts
   * fall back to leaving data alone when this is not provided, because keeping
   * a stale value is always recoverable and deleting a live one is not.
   */
  hasSync?(key: string): boolean;

  /** Resolves when the storage backend is initialized and sync access is available. */
  readonly ready: Promise<void>;
}
