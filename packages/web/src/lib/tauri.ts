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
