/**
 * usePlatformStorage
 *
 * Like useLocalStorage, but stores the value under a platform-prefixed key
 * (e.g. "desktop:corkboard:default-column-count") so each platform
 * (web, desktop, mobile, tablet) can have independent settings.
 *
 * Falls back to the unprefixed key for migration from pre-platform storage.
 */
import { useLocalStorage } from './useLocalStorage';
import { CURRENT_PLATFORM, platformKey } from '@/lib/storageKeys';
import { idbGetSync } from '@/lib/idb';

export function usePlatformStorage<T>(
  baseKey: string,
  defaultValue: T,
  serializer?: {
    serialize: (value: T) => string;
    deserialize: (value: string) => T;
  }
) {
  const prefixedKey = platformKey(CURRENT_PLATFORM, baseKey);

  // Determine the effective default: if no platform-specific value exists,
  // fall back to the unprefixed key (migration from old storage)
  const migratedDefault = (() => {
    // If the prefixed key already has a value, useLocalStorage will find it
    const existing = idbGetSync(prefixedKey);
    if (existing !== null) return defaultValue;

    // Check unprefixed key for migration
    const legacy = idbGetSync(baseKey);
    if (legacy !== null) {
      try {
        const deserialize = serializer?.deserialize ?? (JSON.parse as (v: string) => T);
        return deserialize(legacy);
      } catch {
        return defaultValue;
      }
    }
    return defaultValue;
  })();

  return useLocalStorage<T>(prefixedKey, migratedDefault, serializer);
}
