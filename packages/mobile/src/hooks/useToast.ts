/**
 * Lightweight toast system for React Native.
 *
 * Toasts REMAIN UNTIL DISMISSED (tap) — parity with web, where the Radix
 * provider runs with duration=Infinity. The old version auto-hid after 3s
 * (and on Android used the native ToastAndroid, which cannot persist and
 * bypassed our state entirely — while on iOS the state was never rendered at
 * all, so toasts silently went nowhere). Both platforms now share the same
 * state, rendered by components/ToastOverlay, and an error stays on screen
 * until the user has actually read it.
 */
import React, { createContext, useContext, useCallback, useState } from 'react';

export type ToastType = 'default' | 'success' | 'error';

/** Web-style object payload (title + optional description + variant). Accepted
 *  by toast() for compatibility with web-ported callers. */
export interface ToastInput {
  title: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success' | 'error';
}

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toasts: ToastItem[];
  toast: (input: string | ToastInput, type?: ToastType) => string;
  dismiss: (id?: string) => void;
}

/** Sticky toasts must not fill the screen — oldest drop off past this. */
const MAX_VISIBLE_TOASTS = 4;

/** Normalize either signature down to `{ message, type }`. */
function normalizeToast(input: string | ToastInput, type?: ToastType): { message: string; type: ToastType } {
  if (typeof input === 'string') {
    return { message: input, type: type ?? 'default' };
  }
  const message = input.description ? `${input.title}: ${input.description}` : input.title;
  const t: ToastType =
    input.variant === 'destructive' || input.variant === 'error' ? 'error'
    : input.variant === 'success' ? 'success'
    : 'default';
  return { message, type: t };
}

let idCounter = 0;
function genId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return idCounter.toString();
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/**
 * Provider component for the toast system.
 * Wrap your app root with this (plus a mounted <ToastOverlay />) to enable useToast().
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id?: string) => {
    if (id) {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    } else {
      setToasts([]);
    }
  }, []);

  const toast = useCallback((input: string | ToastInput, type?: ToastType): string => {
    const { message, type: resolvedType } = normalizeToast(input, type);
    const id = genId();
    setToasts((prev) => [...prev, { id, message, type: resolvedType }].slice(-MAX_VISIBLE_TOASTS));
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
