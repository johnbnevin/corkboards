// Debug utility - active in dev mode, when VITE_DEBUG=true, or inside Tauri desktop app
import { isTauri } from '@/lib/tauri';
const DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true' || isTauri;

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

export function debugError(...args: unknown[]) {
  if (DEBUG) {
    console.error('[corkboard]', ...args);
  }
}
