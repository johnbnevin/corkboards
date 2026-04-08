import { useState, useEffect, useRef, useCallback } from 'react';
import { idbGetSync, idbSetSync, idbRemoveSync, idbReady } from '@/lib/idb';

/**
 * Generic hook for managing persistent state backed by IndexedDB.
 *
 * - Initial value is read synchronously from the in-memory IDB cache.
 * - Writes are persisted asynchronously to IndexedDB.
 * - Cross-tab & same-page sync via BroadcastChannel / 'idb-storage-sync' event.
 */
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
      const item = idbGetSync(key);
      return item ? deserialize(item) : defaultValue;
    } catch (error) {
      console.warn(`Failed to load ${key} from IDB cache:`, error);
      return defaultValue;
    }
  });

  // Keep a ref to always-current state so the setValue callback below never
  // reads stale values from a closure, even if it's called in rapid succession.
  const stateRef = useRef<T>(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Re-read from IDB once the database is fully ready (handles the case where
  // the hook mounts before the cache is warmed up, e.g. on very first load).
  useEffect(() => {
    let cancelled = false;
    idbReady.then(() => {
      if (cancelled) return;
      try {
        const item = idbGetSync(key);
        const value = item ? deserialize(item) : defaultValue;
        setState(value);
        stateRef.current = value;
      } catch (error) {
        console.warn(`Failed to sync ${key} after IDB ready:`, error);
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const persistToIdb = useCallback((serialized: string) => {
    if (serialized === null || serialized === undefined || serialized === 'null') {
      idbRemoveSync(key);
    } else {
      idbSetSync(key, serialized);
    }
  }, [key]);

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    try {
      // Resolve the next value using the ref so we always have current state,
      // even when called multiple times before the next render cycle.
      const next = value instanceof Function ? value(stateRef.current) : value;
      stateRef.current = next;
      setState(next);
      const serialized = serialize(next);
      persistToIdb(serialized);
    } catch (error) {
      console.warn(`Failed to save ${key} to IDB:`, error);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, persistToIdb]);

  // Sync with changes from other tabs (BroadcastChannel) and same page
  useEffect(() => {
    const handleSync = (e: CustomEvent<{ key: string; value: unknown }>) => {
      if (e.detail.key !== key) return;
      const next = (e.detail.value === null ? defaultValue : e.detail.value) as T;
      stateRef.current = next;
      setState(next);
    };

    window.addEventListener('idb-storage-sync', handleSync as EventListener);
    return () => {
      window.removeEventListener('idb-storage-sync', handleSync as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [state, setValue] as const;
}
