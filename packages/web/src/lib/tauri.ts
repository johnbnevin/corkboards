/**
 * Tauri desktop bridge.
 *
 * Provides typed wrappers around Tauri IPC commands.
 * All functions are no-ops when not running inside Tauri.
 */

import { withQueryBudget } from '@core/queryGovernor';

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

/**
 * Mirror of the Rust `file_logging` setting, cached so `tauriLog` stays
 * synchronous and cheap.
 *
 * Rust is the authority and refuses to write when logging is off, so this is
 * only an optimisation: without it every console line in the app would still
 * cross the IPC boundary just to be discarded. Starts false so nothing is
 * queued before `initTauriLogging()` reports what the user actually chose.
 */
let _fileLoggingEnabled = false;

function flushLogQueue(): void {
  const batch = _logQueue.splice(0);
  if (batch.length === 0) return;
  invoke('write_log', { message: batch.join('\n') }).catch(() => {});
}

/**
 * Write a message to ~/.local/share/me.corkboards.desktop/debug.log.
 * Batches writes every 50ms so console.log spam doesn't flood IPC.
 * No-op when not running inside Tauri, or when the user has not turned on
 * file logging (it records browsing metadata, so it is opt-in).
 */
export function tauriLog(message: string): void {
  if (!isTauri || !_fileLoggingEnabled) return;
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

// ─── Desktop settings ───────────────────────────────────────────────────────

/**
 * Load the user's file-logging choice into the local mirror.
 *
 * Call once at startup, before anything worth logging happens. Until it
 * resolves `tauriLog` stays silent, which is the right way round: the log
 * holds a record of relay selections, RSS subscriptions and timings, so
 * "not yet known" must behave like "off", never like "on".
 */
export async function initTauriLogging(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    _fileLoggingEnabled = (await invoke<boolean>('get_file_logging')) ?? false;
  } catch {
    _fileLoggingEnabled = false;
  }
  return _fileLoggingEnabled;
}

/** Whether desktop file logging is currently on (cached; see initTauriLogging). */
export function isFileLoggingEnabled(): boolean {
  return _fileLoggingEnabled;
}

/** Turn desktop file logging on/off. Returns the value actually persisted. */
export async function setFileLogging(enabled: boolean): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('set_file_logging', { enabled });
    _fileLoggingEnabled = enabled;
    // Leaving the previous session's lines on disk after the user switches
    // logging off would defeat the point of switching it off.
    if (!enabled) await invoke('clear_log').catch(() => {});
    return enabled;
  } catch (e) {
    console.warn('[tauri] set_file_logging failed:', e);
    return _fileLoggingEnabled;
  }
}

/** Whether the window is excluded from screen capture (desktop only). */
export async function getContentProtected(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return (await invoke<boolean>('get_content_protected')) ?? true;
  } catch {
    return true;
  }
}

/**
 * Set screen-capture protection. Takes effect on the NEXT launch — Tauri can
 * only apply the flag when the window is built — so callers must say so rather
 * than implying the change was immediate.
 */
export async function setContentProtected(enabled: boolean): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('set_content_protected', { enabled });
    return true;
  } catch (e) {
    console.warn('[tauri] set_content_protected failed:', e);
    return false;
  }
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

// keychainGet was removed: the `keychain_get` IPC command is no longer exposed to
// the webview (it could exfiltrate the nsec via XSS). Secrets stay in Rust —
// signing/encryption use sign_event / nip04_* / nip44_* which never return the key.

/**
 * Whether the OS keychain still holds the signing key for `pubkey`.
 *
 * Returns true off-desktop and on error: this drives a "your key is missing"
 * warning, and a false positive there would tell users their key is gone
 * whenever the check itself hiccups — worse than staying quiet.
 */
export async function keychainHasKey(pubkey: string): Promise<boolean> {
  if (!isTauri) return true;
  try {
    return (await invoke<boolean>('keychain_has', { key: `nsec:${pubkey}` })) ?? true;
  } catch (e) {
    console.warn('[tauri] keychain_has failed:', e);
    return true;
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

// ─── External links ──────────────────────────────────────────────────────────

/**
 * Hand a URL to the host process so the OS opens it in the default browser.
 *
 * Only meaningful inside Tauri. Returns false when not in Tauri (caller should
 * fall back to `window.open`) or when the host refused the URL — Rust re-checks
 * the scheme, so this can fail even after the caller's own check.
 */
export async function tauriOpenExternal(url: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('open_external', { url });
    return true;
  } catch (e) {
    console.warn('[tauri] open_external failed:', e);
    return false;
  }
}

/**
 * Hand a `lightning:` invoice URI to the host so the OS opens it in whatever
 * wallet is registered for the scheme.
 *
 * Separate from `open_external` on purpose — that command refuses every
 * non-web scheme, and relaxing it would turn it into a generic local-handler
 * launcher reachable from note content. Rust re-validates the invoice shape.
 * Returns false outside Tauri, or when the host refused / found no handler.
 */
export async function tauriOpenLightning(uri: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('open_lightning', { uri });
    return true;
  } catch (e) {
    console.warn('[tauri] open_lightning failed:', e);
    return false;
  }
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
 * Monotonic counter for relay subscription ids.
 *
 * The id names the Tauri event channel (`relay-${subId}`) that Rust emits
 * batches on. It used to be `Math.random().toString(36).slice(2, 10)` — with
 * many concurrent feed queries in flight, two subscriptions drawing the same
 * value would both listen on one channel and interleave each other's events,
 * so one query would resolve with another's results. A counter cannot collide
 * within a process; the random suffix keeps ids distinct across reloads so a
 * listener that outlived its query can't catch the next session's traffic.
 */
let _subIdCounter = 0;
const _subIdSalt = Math.random().toString(36).slice(2, 8);
function nextSubId(): string {
  _subIdCounter += 1;
  return `${_subIdSalt}-${_subIdCounter.toString(36)}`;
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
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (!isTauri || urls.length === 0) return [];

  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  const { listen: tauriListen } = await import('@tauri-apps/api/event');

  const subId = nextSubId();
  const allEvents: unknown[] = [];
  const seen = new Set<string>();

  // ── Why there is no verifyEvent() here ──────────────────────────────────────
  //
  // There used to be. When the native bridge was first written, Rust forwarded
  // raw relay JSON unvalidated, so this loop ran nostr-tools' verifyEvent on
  // every event to stop a hostile relay injecting forged notes/profiles (C1).
  //
  // Rust now does that check itself, and does strictly more of it:
  //   relay.rs `authentic_event()`  — deserialize + `event.verify()` (id hash +
  //                                    schnorr), fail-closed on any error
  //   relay.rs `matches_filter()`   — the event must also satisfy the REQ filter
  //                                    we actually sent (which this JS check
  //                                    never did — see the relay-list poisoning
  //                                    case in `rejects_signed_but_unrequested_events`)
  // Both run unconditionally inside `run_query`, on the path taken by BOTH
  // `relay_subscribe` and `relay_query`, and both are locked down by tests in
  // relay.rs (`rejects_unauthentic_events`, `rejects_signed_but_unrequested_events`,
  // `accepts_requested_events`). Nothing reaches this callback unverified.
  //
  // Re-verifying here was therefore pure duplicated work — and it was not cheap.
  // Schnorr verification in JS measures ~2.65 ms per event on a low-end 2-core
  // laptop, and this loop is SYNCHRONOUS inside the Tauri event callback, so it
  // blocks the main thread for the entire batch. A single 500-event query (the
  // engagement fetch) spent well over a second of solid main-thread block
  // re-checking signatures Rust had already checked in native code. On a 2-core
  // machine that is the difference between a busy app and an unresponsive
  // desktop.
  //
  // If the Rust checks are ever removed, restore this one — but the fix belongs
  // in Rust, where it costs native-speed crypto on a worker thread instead of
  // interpreted crypto on the UI thread.

  return new Promise<unknown[]>((resolve) => {
    let unlistenFn: (() => void) | null = null;
    let settled = false;
    // Client-side backstop.
    //
    // This promise resolved ONLY on a `done: true` payload. Rust has its own
    // timeout, so in the normal case that emit always arrives — but it is an
    // app.emit() across the webview bridge, and if it is ever lost (the window
    // closing mid-query, a dropped/never-registered listener, a panic in the
    // emitting task) the promise NEVER settles. That is not merely a hung
    // query: every tauriQuery runs inside `withQueryBudget`, so an unsettled
    // one holds a global query-governor slot forever. A handful of those and
    // the desktop app stops querying anything at all, with no error anywhere —
    // it just quietly goes dead. Give Rust its own deadline plus generous
    // slack, then settle with whatever we received.
    const backstop = setTimeout(() => {
      if (settled) return;
      console.warn(`[tauri] relay query ${subId} produced no completion signal within ${timeoutMs + 5000}ms — settling with ${allEvents.length} events`);
      finish();
    }, timeoutMs + 5000);

    let onAbort: (() => void) | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      unlistenFn?.();
      resolve(allEvents);
    };

    // An abort STOPS the read and keeps what arrived — it does not discard it.
    //
    // This used to be a `Promise.race` in NostrProvider that REJECTED on abort,
    // and callers pass `AbortSignal.timeout(5000)` against a native budget of
    // exactly 5000 ms. The two expire together, the abort usually wins by a
    // hair, and every event Rust had already collected was thrown away — so
    // "load 25/100 more" reliably did nothing on desktop while working on web.
    // NRelay1 has always behaved this way (its timeout closes the socket and
    // keeps the partial page), and `run_query` in relay.rs deliberately does the
    // same on its own deadline. This makes the third layer agree with them.
    if (signal) {
      if (signal.aborted) {
        // Nothing has been collected yet; settle rather than start a query.
        clearTimeout(backstop);
        settled = true;
        resolve([]);
        return;
      }
      onAbort = () => finish();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    tauriListen<RelayBatch>(`relay-${subId}`, (event) => {
      if (settled) return;
      const { events, done } = event.payload;
      for (const ev of events) {
        const e = ev as { id?: string };
        if (e.id && !seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(ev);
        }
      }
      if (done) finish();
    }).then((unlisten) => {
      unlistenFn = unlisten;
      // The backstop may already have fired while `listen` was resolving; if so
      // this listener is orphaned, so detach it immediately rather than leaving
      // it registered for the life of the window.
      if (settled) { unlisten(); return; }
      tauriInvoke('relay_subscribe', {
        subId,
        urls,
        filter,
        timeoutMs,
      }).catch((err) => {
        console.warn('[tauri] relay_subscribe failed:', err);
        finish();
      });
    }).catch((err) => {
      console.warn('[tauri] listen failed:', err);
      finish();
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
 * True when "require proxy" is ON but this session's WebView is NOT routed
 * through a proxy. The Rust kill-switch only covers native relay sockets; when
 * this is set, WebView traffic (images, embeds, JS-opened relay sockets) is
 * going out directly, so a Tor-only user needs to be told loudly. Latched at
 * window creation — the WebView proxy can only change on restart.
 */
export async function tauriProxyWebviewUnprotected(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return (await invoke<boolean>('proxy_webview_unprotected')) ?? false;
  } catch {
    return false;
  }
}

/**
 * Whether publishing must be refused because the user requires a proxy and this
 * window is not behind one.
 *
 * Publishing rides the webview's own WebSocket, which relay.rs's kill-switch
 * cannot see — so without this check a Tor-only user kept emitting SIGNED
 * events over clearnet (linking npub to IP) while their reads were correctly
 * blocked. Reads failing closed and writes not is exactly backwards: the write
 * is the identity-bearing half.
 *
 * The answer changes only on restart (the webview's proxy is fixed at window
 * creation) EXCEPT for the `proxy_required` half, which the user can toggle
 * live — so this re-asks each time rather than caching, and one IPC round trip
 * per publish is nothing next to the relay round trip that follows. On error it
 * returns false: this must not become a way to block posting.
 */
export async function isPublishBlockedByProxy(): Promise<boolean> {
  return tauriProxyWebviewUnprotected();
}

/**
 * Query a relay via Rust tokio-tungstenite (bypasses WebKitGTK WebSocket).
 * Returns null if not in Tauri or on error.
 *
 * Like {@link tauriQuery}, events are NOT re-verified here — `relay_query` and
 * `relay_subscribe` share the same `do_query` → `run_query` path in relay.rs,
 * which runs `authentic_event()` (id hash + schnorr, fail-closed) and
 * `matches_filter()` on every event before it crosses the IPC boundary. See the
 * long note in {@link tauriQuery} for why the duplicated JS check was removed.
 *
 * The filter-matching half matters most on THIS path: `fetchEvent.ts` uses it to
 * discover kind-10002 relay lists and feeds the result to `updateRelayCache()`,
 * so a relay answering a kind-10002 request with some other validly-signed event
 * would get a forged relay list PERSISTED. A signature check alone never caught
 * that; `matches_filter` does (see `rejects_signed_but_unrequested_events`).
 */
export async function tauriRelayQuery(
  url: string,
  filter: Record<string, unknown>,
  timeoutMs?: number,
): Promise<RelayQueryResult | null> {
  if (!isTauri) return null;
  try {
    // Governed alongside every other relay read so per-feature caps can't
    // compose into an unbounded number of concurrent native sockets.
    const res = await withQueryBudget(() =>
      invoke<RelayQueryResult>('relay_query', { url, filter, timeoutMs }),
    );
    if (!res) return null;
    return res;
  } catch (e) {
    console.warn('[tauri] relay_query failed:', e);
    return null;
  }
}
