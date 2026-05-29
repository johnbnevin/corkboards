/**
 * Tauri desktop bridge.
 *
 * Provides typed wrappers around Tauri IPC commands.
 * All functions are no-ops when not running inside Tauri.
 */

/** True when running inside the Tauri desktop app.
 * Checks both v1 (__TAURI__) and v2 (__TAURI_INTERNALS__) globals.
 * withGlobalTauri:true in tauri.conf.json ensures __TAURI__ is set in v2 as well. */
export const isTauri = typeof window !== 'undefined' && (
  '__TAURI__' in window || '__TAURI_INTERNALS__' in window
);

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

// ─── Native Signer (nsec stays in Rust/keychain) ──────────────────────────────
// These delegate signing + NIP-04/44 encryption to Rust so the nsec never enters
// JS. Used by createTauriNsecSigner (lib/tauriSigner.ts) for nsec logins on
// desktop. They throw when not in Tauri — callers only use them in that context.

/** Sign an unsigned event template in Rust; returns the full signed event. */
export async function tauriSignEvent(
  pubkey: string,
  unsigned: { kind: number; content: string; tags: string[][]; created_at: number },
): Promise<Record<string, unknown>> {
  const res = await invoke<Record<string, unknown>>('sign_event', { pubkey, unsigned });
  if (!res) throw new Error('tauriSignEvent: not running in Tauri');
  return res;
}

export async function tauriNip44Encrypt(pubkey: string, peerPubkey: string, plaintext: string): Promise<string> {
  const res = await invoke<string>('nip44_encrypt', { pubkey, peerPubkey, plaintext });
  if (res == null) throw new Error('tauriNip44Encrypt: not running in Tauri');
  return res;
}

export async function tauriNip44Decrypt(pubkey: string, peerPubkey: string, ciphertext: string): Promise<string> {
  const res = await invoke<string>('nip44_decrypt', { pubkey, peerPubkey, ciphertext });
  if (res == null) throw new Error('tauriNip44Decrypt: not running in Tauri');
  return res;
}

export async function tauriNip04Encrypt(pubkey: string, peerPubkey: string, plaintext: string): Promise<string> {
  const res = await invoke<string>('nip04_encrypt', { pubkey, peerPubkey, plaintext });
  if (res == null) throw new Error('tauriNip04Encrypt: not running in Tauri');
  return res;
}

export async function tauriNip04Decrypt(pubkey: string, peerPubkey: string, ciphertext: string): Promise<string> {
  const res = await invoke<string>('nip04_decrypt', { pubkey, peerPubkey, ciphertext });
  if (res == null) throw new Error('tauriNip04Decrypt: not running in Tauri');
  return res;
}

// ─── Native Relay Query ───────────────────────────────────────────────────────

interface RelayQueryResult {
  events: unknown[];
  error?: string;
}

interface RelayBatch {
  events: unknown[];
  done: boolean;
}

/**
 * Query multiple relays via Rust, streaming results back via app.emit() batches.
 *
 * Uses app.emit() + listen() instead of Channel<T>. Channel<T> hangs silently when
 * the Tauri IPC custom protocol falls back to postMessage (Tauri bug #9266) —
 * app.emit() uses webkit_web_view_run_javascript directly and bypasses IPC entirely.
 */
export async function tauriQuery(
  urls: string[],
  filter: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<unknown[]> {
  if (!isTauri || urls.length === 0) return [];

  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  const { listen: tauriListen } = await import('@tauri-apps/api/event');

  const subId = Math.random().toString(36).slice(2, 10);
  const allEvents: unknown[] = [];
  const seen = new Set<string>();

  return new Promise<unknown[]>((resolve) => {
    let unlistenFn: (() => void) | null = null;
    const cleanup = () => { unlistenFn?.(); };

    tauriListen<RelayBatch>(`relay-${subId}`, (event) => {
      const { events, done } = event.payload;
      for (const ev of events) {
        const e = ev as { id?: string };
        if (e.id && !seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(ev);
        }
      }
      if (done) {
        cleanup();
        resolve(allEvents);
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
      tauriInvoke('relay_subscribe', {
        subId,
        urls,
        filter,
        timeoutMs,
      }).catch((err) => {
        console.warn('[tauri] relay_subscribe failed:', err);
        cleanup();
        resolve(allEvents);
      });
    }).catch((err) => {
      console.warn('[tauri] listen failed:', err);
      resolve(allEvents);
    });
  });
}

// ─── SOCKS5 Proxy ────────────────────────────────────────────────────────────

/**
 * Read the currently configured SOCKS5 proxy URL.
 * Returns null when not in Tauri or when no proxy is set.
 */
export async function tauriGetProxy(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return (await invoke<string | null>('get_proxy')) ?? null;
  } catch (e) {
    console.warn('[tauri] get_proxy failed:', e);
    return null;
  }
}

/**
 * Set or clear the SOCKS5 proxy used by native relay queries.
 * Pass `null`/empty to clear. URL must be `socks5://host:port` or `socks5h://host:port`.
 * Throws on invalid format.
 */
export async function tauriSetProxy(url: string | null): Promise<void> {
  if (!isTauri) return;
  await invoke('set_proxy', { url: url && url.trim().length > 0 ? url.trim() : null });
}

/**
 * Read the "require proxy" kill-switch. When true, native relay queries refuse
 * to fall back to a direct clearnet connection if the proxy is unset/fails.
 */
export async function tauriGetProxyRequired(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return (await invoke<boolean>('get_proxy_required')) ?? false;
  } catch (e) {
    console.warn('[tauri] get_proxy_required failed:', e);
    return false;
  }
}

/** Enable/disable the "require proxy" kill-switch. */
export async function tauriSetProxyRequired(required: boolean): Promise<void> {
  if (!isTauri) return;
  await invoke('set_proxy_required', { required });
}

/**
 * True if the proxy config file existed but failed to parse — the UI should
 * warn the user their proxy setting may not be active (avoids silent clearnet).
 */
export async function tauriProxyLoadFailed(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return (await invoke<boolean>('proxy_load_failed')) ?? false;
  } catch {
    return false;
  }
}

/**
 * Query a relay via Rust tokio-tungstenite (bypasses WebKitGTK WebSocket).
 * Returns null if not in Tauri or on error.
 */
export async function tauriRelayQuery(
  url: string,
  filter: Record<string, unknown>,
  timeoutMs?: number,
): Promise<RelayQueryResult | null> {
  if (!isTauri) return null;
  try {
    return await invoke<RelayQueryResult>('relay_query', {
      url,
      filter,
      timeoutMs,
    });
  } catch (e) {
    console.warn('[tauri] relay_query failed:', e);
    return null;
  }
}
