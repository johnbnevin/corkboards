import { useState, useCallback, useRef, useEffect } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { mobileStorage } from '../storage/MmkvStorage';
import { emitStorageSync } from '../lib/storageSync';

// Cross-component sync (parity with web's 'idb-storage-sync' CustomEvent).
// When one component writes to a key, every other component subscribed to
// the same key updates immediately — otherwise a global setter in the
// profile modal would silently fail to refresh the home screen's list.
//
// Event payload is the key name only — never the value. This keeps each
// invalidation a tiny bridge crossing; subscribers re-read from MMKV (which
// is mmap-backed and effectively free) instead of serializing potentially
// hundreds of KB across the JS bridge on every write.
const SYNC_EVENT = 'mobile-storage-sync';

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  serializer?: {
    serialize: (value: T) => string;
    deserialize: (value: string) => T;
  }
) {
  const serialize = serializer?.serialize ?? JSON.stringify;
  const deserialize = serializer?.deserialize ?? (JSON.parse as (v: string) => T);

  const [state, setState] = useState<T>(() => {
    try {
      const item = mobileStorage.getSync(key);
      return item ? deserialize(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const stateRef = useRef<T>(state);
  useEffect(() => { stateRef.current = state; });

  // Track our own emitter id so we can ignore echoes of our own writes.
  // Compute once via useState's initializer (runs exactly once per mount),
  // which the v7 purity rule accepts as a one-time-init pattern.
  const [emitterId] = useState(() => Math.random().toString(36).slice(2));
  const emitterIdRef = useRef(emitterId);

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    try {
      const next = value instanceof Function ? value(stateRef.current) : value;
      stateRef.current = next;
      setState(next);
      const serialized = serialize(next);
      if (serialized === null || serialized === undefined || serialized === 'null') {
        mobileStorage.removeSync(key);
      } else {
        mobileStorage.setSync(key, serialized);
      }
      // Broadcast through the SHARED bus (lib/storageSync), which fans out to
      // both subscription styles: this hook's DeviceEventEmitter channel and
      // the module-listener Set that useBookmarks/useCollapsedNotes and the
      // backup merge use. Emitting only on the RN channel is why the two buses
      // used to be one-way — see storageSync.ts.
      emitStorageSync(key, serialized, emitterIdRef.current);
    } catch (error) {
      console.warn(`[useLocalStorage] Failed to save ${key}:`, error);
    }
  }, [key, serialize]);

  // Listen for cross-component writes to the same key — re-read from MMKV.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(SYNC_EVENT, (e: { key: string; originId: string }) => {
      if (e.key !== key) return;
      if (e.originId === emitterIdRef.current) return; // ignore our own emit
      try {
        const raw = mobileStorage.getSync(key);
        const next = raw ? deserialize(raw) : defaultValue;
        stateRef.current = next;
        setState(next);
      } catch (error) {
        console.warn(`[useLocalStorage] Failed to re-read ${key} on sync:`, error);
      }
    });
    return () => sub.remove();
  }, [key, defaultValue, deserialize]);

  return [state, setValue] as const;
}
