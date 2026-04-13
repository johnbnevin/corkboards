import { useLocalStorage } from './useLocalStorage';
import { getCurrentPlatform, platformKey } from '../lib/storageKeys';
import { mobileStorage } from '../storage/MmkvStorage';

export function usePlatformStorage<T>(
  baseKey: string,
  defaultValue: T,
  serializer?: {
    serialize: (value: T) => string;
    deserialize: (value: string) => T;
  }
) {
  const prefixedKey = platformKey(getCurrentPlatform(), baseKey);

  const migratedDefault = (() => {
    const existing = mobileStorage.getSync(prefixedKey);
    if (existing !== null) return defaultValue;
    const legacy = mobileStorage.getSync(baseKey);
    if (legacy !== null) {
      try {
        const deserialize = serializer?.deserialize ?? (JSON.parse as (v: string) => T);
        return deserialize(legacy);
      } catch { return defaultValue; }
    }
    return defaultValue;
  })();

  return useLocalStorage<T>(prefixedKey, migratedDefault, serializer);
}
