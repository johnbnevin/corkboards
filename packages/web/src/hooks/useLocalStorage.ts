import { useState, useEffect, useRef, useCallback } from 'react';
import { idbGetSync, idbGet, idbSetSync, idbRemoveSync, idbReady, nextWriteOrigin } from '@/lib/idb';

/**
 * Deserialize, reporting success separately from the value.
 *
 * A `{ ok, value }` pair rather than `T | null`, because `null` is a perfectly
 * valid deserialized value and conflating it with "this wasn't the serialized
 * form" would make a legitimately-null stored value fall back to the raw string.
 */
function tryDeserialize<T>(raw: string, deserialize: (v: string) => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: deserialize(raw) };
  } catch {
    return { ok: false };
  }
}

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
    idbReady.then(async () => {
      if (cancelled) return;
      try {
        let item = idbGetSync(key);
        if (item === null) {
          // Defense: memCache may be missing this key (e.g. evicted under
          // MAX_MEM_CACHE pressure). Fall back to async IDB so we never
          // mistake "not cached" for "not present" and clobber real data.
          item = await idbGet(key);
          if (cancelled) return;
        }
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

  // Identity for this hook instance's writes. The sync event echoes it back so
  // `handleSync` below can skip the value this instance just wrote — its state
  // is already correct, and re-applying it costs a full deserialize plus a
  // render with a fresh object identity, which invalidates every memo
  // downstream. Other instances of the same key (and other tabs) still update.
  const writeOrigin = useRef<string>();
  if (!writeOrigin.current) writeOrigin.current = nextWriteOrigin();

  const persistToIdb = useCallback((serialized: string) => {
    if (serialized === null || serialized === undefined || serialized === 'null') {
      idbRemoveSync(key);
    } else {
      idbSetSync(key, serialized, writeOrigin.current);
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

  // Refs so the sync listener below can use the CURRENT (de)serializer without
  // re-registering on every render — `serializer` is usually an inline object
  // literal, so it has a fresh identity each time.
  const deserializeRef = useRef(deserialize);
  deserializeRef.current = deserialize;

  // Sync with changes from other tabs (BroadcastChannel) and same page
  useEffect(() => {
    const ac = new AbortController();
    const handleSync = (e: CustomEvent<{ key: string; value: unknown; origin?: string }>) => {
      if (e.detail.key !== key) return;
      // Our own write coming back — state already holds it.
      if (e.detail.origin && e.detail.origin === writeOrigin.current) return;
      if (e.detail.value === null) {
        stateRef.current = defaultValue;
        setState(defaultValue);
        return;
      }

      // Run the incoming value through the CALLER'S deserialize.
      //
      // lib/idb.ts dispatches `tryParse(rawString)` — a bare `JSON.parse`. Every
      // other path into this hook (initial read, idbReady re-read) goes through
      // `deserialize`, so a hook with a custom one — reviving a Set, migrating an
      // old shape, clamping a range, applying a default for a missing field —
      // had all of that silently skipped here, and only here. The value landed in
      // state as whatever JSON.parse produced, so a cross-tab write or a backup
      // restore could install a shape the component's own contract says is
      // impossible, from the one code path that never validates. (L18)
      const raw = e.detail.value;
      try {
        let next: T;
        if (typeof raw === 'string') {
          // A string may be the serialized form (custom serializer whose output
          // isn't valid JSON, so tryParse handed it back untouched) or a genuine
          // string value. Try it as the serialized form first, and fall back to
          // the string itself only when deserializing actually threw — hence the
          // explicit `ok` check rather than `??`, which would never fire on a
          // result object that is always non-nullish.
          const attempt = tryDeserialize(raw, deserializeRef.current);
          next = attempt.ok ? attempt.value : (raw as unknown as T);
        } else {
          next = deserializeRef.current(JSON.stringify(raw));
        }
        stateRef.current = next;
        setState(next);
      } catch (error) {
        console.warn(`Failed to deserialize synced value for ${key}:`, error);
      }
    };

    window.addEventListener('idb-storage-sync', handleSync as EventListener, { signal: ac.signal });
    return () => ac.abort();
  }, [key, defaultValue]);

  return [state, setValue] as const;
}
