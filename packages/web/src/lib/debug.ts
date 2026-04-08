// Debug utility - only active in dev mode or when VITE_DEBUG=true
const DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true';

export function debugLog(...args: unknown[]) {
  if (DEBUG) {
    console.log('[corkboard]', ...args);
  }
}

export function debugWarn(...args: unknown[]) {
  if (DEBUG) {
    console.warn('[corkboard]', ...args);
  }
}
