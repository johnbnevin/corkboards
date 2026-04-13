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
