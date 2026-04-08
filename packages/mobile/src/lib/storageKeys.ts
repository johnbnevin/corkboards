/**
 * Mobile-specific storage keys adapter.
 *
 * Wraps core storageKeys functions with the MMKV storage backend
 * and sets platform to 'mobile' (or 'tablet' based on screen size).
 */
import { Dimensions } from 'react-native';
import { mobileStorage } from '../storage/MmkvStorage';
import type { KVStorage } from '@core/storage';
import type { Platform } from '@core/storageKeys';
import {
  STORAGE_KEYS,
  PER_USER_KEYS,
  BACKED_UP_KEYS,
  PLATFORM_SPECIFIC_KEYS,
  platformKey,
  getPlatformSetting as _getPlatformSetting,
  setPlatformSetting as _setPlatformSetting,
  stashUserData as _stashUserData,
  clearActiveUserData as _clearActiveUserData,
  restoreUserData as _restoreUserData,
  switchActiveUser as _switchActiveUser,
  getActiveUserPubkey as _getActiveUserPubkey,
  handleLogoutStorage as _handleLogoutStorage,
} from '@core/storageKeys';

export {
  STORAGE_KEYS, PER_USER_KEYS, BACKED_UP_KEYS,
  PLATFORM_SPECIFIC_KEYS, platformKey,
};

/** Detect mobile vs tablet based on screen width (deferred — not safe at module load) */
export function detectPlatform(): Platform {
  const { width } = Dimensions.get('window');
  return width >= 768 ? 'tablet' : 'mobile';
}

let _cachedPlatform: Platform | null = null;

export function getCurrentPlatform(): Platform {
  if (!_cachedPlatform) _cachedPlatform = detectPlatform();
  return _cachedPlatform;
}

const storage = mobileStorage as KVStorage;

export function getPlatformSetting(baseKey: string): string | null {
  return _getPlatformSetting(storage, getCurrentPlatform(), baseKey);
}

export function setPlatformSetting(baseKey: string, value: string): void {
  _setPlatformSetting(storage, getCurrentPlatform(), baseKey, value);
}

export function stashUserData(pubkey: string): void {
  _stashUserData(storage, pubkey);
}

export function clearActiveUserData(): void {
  _clearActiveUserData(storage);
}

export function restoreUserData(pubkey: string): void {
  _restoreUserData(storage, pubkey);
}

export function switchActiveUser(oldPubkey: string | null, newPubkey: string): void {
  _switchActiveUser(storage, oldPubkey, newPubkey);
}

export function getActiveUserPubkey(): string | null {
  return _getActiveUserPubkey(storage);
}

export function handleLogoutStorage(pubkey: string): void {
  _handleLogoutStorage(storage, pubkey);
}
