// Debug utility - only active in dev mode
const DEBUG = __DEV__;

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

/** Parity with web's lib/debug.ts, which exports the same three levels. */
export function debugError(...args: unknown[]) {
  if (DEBUG) {
    console.error('[corkboard]', ...args);
  }
}
