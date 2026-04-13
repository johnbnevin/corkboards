import { useState, useCallback, useRef, useEffect } from 'react';
import { mobileStorage } from '../storage/MmkvStorage';

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
    } catch (error) {
      console.warn(`[useLocalStorage] Failed to save ${key}:`, error);
    }
  }, [key, serialize]);

  return [state, setValue] as const;
}
