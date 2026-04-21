/**
 * Tauri desktop bridge.
 *
 * Provides typed wrappers around Tauri IPC commands.
 * All functions are no-ops when not running inside Tauri.
 */

/** True when running inside the Tauri desktop app */
export const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

/** Invoke a Tauri command. Returns null if not in Tauri. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri) return null;
  // Dynamic import so this module doesn't fail in browser
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

// ─── File Logger ─────────────────────────────────────────────────────────────

/** Queued log messages — flushed in a batch every 50ms to reduce IPC overhead */
const _logQueue: string[] = [];
let _logFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushLogQueue(): void {
  const batch = _logQueue.splice(0);
  if (batch.length === 0) return;
  invoke('write_log', { message: batch.join('\n') }).catch(() => {});
}

/**
 * Write a message to ~/.local/share/me.corkboards.desktop/debug.log.
 * Batches writes every 50ms so console.log spam doesn't flood IPC.
 * No-op when not running inside Tauri.
 */
export function tauriLog(message: string): void {
  if (!isTauri) return;
  _logQueue.push(message);
  if (!_logFlushTimer) {
    _logFlushTimer = setTimeout(() => {
      _logFlushTimer = null;
      flushLogQueue();
    }, 50);
  }
}

/**
 * Clear the log file and write a fresh header.
 * Called on app startup so each session starts clean.
 */
export async function clearTauriLog(): Promise<void> {
  await invoke('clear_log');
}

// ─── OS Keychain ────────────────────────────────────────────────────────────

/** Store a secret in the OS keychain. */
export async function keychainStore(key: string, value: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('keychain_store', { key, value });
    return true;
  } catch (e) {
    console.warn('[tauri] keychain_store failed:', e);
    return false;
  }
}

/** Retrieve a secret from the OS keychain. */
export async function keychainGet(key: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return await invoke<string | null>('keychain_get', { key }) ?? null;
  } catch (e) {
    console.warn('[tauri] keychain_get failed:', e);
    return null;
  }
}

/** Delete a secret from the OS keychain. */
export async function keychainDelete(key: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('keychain_delete', { key });
    return true;
  } catch (e) {
    console.warn('[tauri] keychain_delete failed:', e);
    return false;
  }
}
