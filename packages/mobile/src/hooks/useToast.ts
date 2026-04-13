/**
 * Lightweight toast system for React Native.
 * Uses ToastAndroid on Android, a simple context-based overlay on iOS.
 */
import React, { createContext, useContext, useCallback, useState, useRef } from 'react';
import { Platform, ToastAndroid } from 'react-native';

export type ToastType = 'default' | 'success' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toasts: ToastItem[];
  toast: (message: string, type?: ToastType) => string;
  dismiss: (id?: string) => void;
}

let idCounter = 0;
function genId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return idCounter.toString();
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const AUTO_DISMISS_MS = 3000;

/**
 * Provider component for the toast system.
 * Wrap your app root with this to enable useToast().
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id?: string) => {
    if (id) {
      const timer = timersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
      setToasts((prev) => prev.filter((t) => t.id !== id));
    } else {
      // Dismiss all
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
      setToasts([]);
    }
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'default'): string => {
    // On Android, use native toast for simple messages
    if (Platform.OS === 'android') {
      ToastAndroid.show(message, ToastAndroid.SHORT);
      return genId();
    }

    // On iOS, use context-based state
    const id = genId();
    setToasts((prev) => [...prev, { id, message, type }]);

    // Auto-dismiss after timeout
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, timer);

    return id;
  }, []);

  const value = React.useMemo(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss]);

  return React.createElement(ToastContext.Provider, { value }, children);
}

/**
 * Hook to show toast notifications.
 * Must be used within a ToastProvider.
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
