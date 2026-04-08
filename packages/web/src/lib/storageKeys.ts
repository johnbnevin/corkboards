/**
 * Web-specific storage keys adapter.
 *
 * Re-exports pure data from @core/storageKeys and wraps the
 * storage-dependent functions to use the web IndexedDB backend.
 *
 * Detects Tauri desktop vs browser to set the correct platform.
 */
import { idbGetSync, idbSetSync, idbRemoveSync, idbGet, idbSet, idbRemove, idbClear, idbKeys, idbGetAll, idbReady } from '@/lib/idb';
import type { KVStorage } from '@core/storage';
import type { Platform } from '@core/storageKeys';
import {
  STORAGE_KEYS,
  PER_USER_KEYS,
  BACKED_UP_KEYS,
  PLATFORM_SPECIFIC_KEYS,
  ALL_PLATFORMS,
  platformKey,
  getPlatformSetting as _getPlatformSetting,
  setPlatformSetting as _setPlatformSetting,
  removePlatformSetting as _removePlatformSetting,
  getAllBackupKeys,
  stashUserData as _stashUserData,
  clearActiveUserData as _clearActiveUserData,
  restoreUserData as _restoreUserData,
  switchActiveUser as _switchActiveUser,
  getActiveUserPubkey as _getActiveUserPubkey,
  handleLogoutStorage as _handleLogoutStorage,
  handleLogoutStorageAsync as _handleLogoutStorageAsync,
} from '@core/storageKeys';

// Re-export pure data
export {
  STORAGE_KEYS, PER_USER_KEYS, BACKED_UP_KEYS,
  PLATFORM_SPECIFIC_KEYS, ALL_PLATFORMS,
  platformKey, getAllBackupKeys,
};
export type { Platform };

/** Detect the current platform at runtime */
export function detectPlatform(): Platform {
  if (typeof window !== 'undefined' && '__TAURI__' in window) return 'desktop';
  return 'web';
}

/** Current platform — cached at module load */
export const CURRENT_PLATFORM: Platform = detectPlatform();

// Web KVStorage adapter backed by idb.ts (sync cache + full async IDB API)
const webStorage: KVStorage = {
  getSync: idbGetSync,
  setSync: idbSetSync,
  removeSync: idbRemoveSync,
  get: idbGet,
  set: idbSet,
  remove: idbRemove,
  clear: idbClear,
  keys: idbKeys,
  getAll: idbGetAll,
  ready: idbReady,
};

// ─── Platform-aware setting helpers (bound to current platform) ─────────────

/** Read a platform-specific setting for the current platform, with fallback to unprefixed */
export function getPlatformSetting(baseKey: string): string | null {
  return _getPlatformSetting(webStorage, CURRENT_PLATFORM, baseKey);
}

/** Write a platform-specific setting for the current platform */
export function setPlatformSetting(baseKey: string, value: string): void {
  _setPlatformSetting(webStorage, CURRENT_PLATFORM, baseKey, value);
}

/** Remove a platform-specific setting for the current platform */
export function removePlatformSetting(baseKey: string): void {
  _removePlatformSetting(webStorage, CURRENT_PLATFORM, baseKey);
}

/**
 * Check if a key is platform-specific.
 * If so, callers should use getPlatformSetting/setPlatformSetting instead of raw idb access.
 */
export function isPlatformSpecificKey(key: string): boolean {
  return (PLATFORM_SPECIFIC_KEYS as readonly string[]).includes(key);
}

// ─── User isolation (bound to webStorage) ───────────────────────────────────

export function stashUserData(pubkey: string): void {
  _stashUserData(webStorage, pubkey);
}

export function clearActiveUserData(): void {
  _clearActiveUserData(webStorage);
}

export function restoreUserData(pubkey: string): void {
  _restoreUserData(webStorage, pubkey);
}

export function switchActiveUser(oldPubkey: string | null, newPubkey: string): void {
  _switchActiveUser(webStorage, oldPubkey, newPubkey);
}

export function getActiveUserPubkey(): string | null {
  return _getActiveUserPubkey(webStorage);
}

export function handleLogoutStorage(pubkey: string): void {
  _handleLogoutStorage(webStorage, pubkey);
}

export async function handleLogoutStorageAsync(pubkey: string): Promise<void> {
  return _handleLogoutStorageAsync(webStorage, pubkey);
}
