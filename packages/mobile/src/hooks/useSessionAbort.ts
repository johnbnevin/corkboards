/**
 * Session-scoped AbortController for race-free account switching.
 *
 * Why: when the user switches accounts (or logs out / logs in), any in-flight
 * Nostr subscriptions or queries scoped to the *old* pubkey can resolve after
 * the new account is active. Their results then get written into the new
 * account's UI state — cross-account leakage that breaks the cypherpunk
 * promise of strict per-account isolation.
 *
 * Web has a hard `window.location.reload()` on account switch which kills all
 * in-flight work implicitly. Mobile has no equivalent — state changes in
 * place — so this module is the only thing standing between in-flight queries
 * for account A and the freshly-mounted UI for account B.
 *
 * Pattern:
 *   - One module-level AbortController per active session.
 *   - `bumpSessionEpoch()` aborts the current controller and creates a fresh
 *     one. Call it at the very top of every auth transition (switchAccount,
 *     loginWithNsec, loginWithBunker, logout, removeAccount).
 *   - Long-running data hooks call `getSessionSignal()` and pass it to
 *     `nostr.query(filters, { signal })` so the underlying NPool aborts the
 *     network work on bump.
 *   - Pure react-query callers can also subscribe via `useSessionEpoch()` and
 *     re-check `signal.aborted` before applying results to state.
 */
import { useSyncExternalStore } from 'react';

let _controller = new AbortController();
let _epoch = 0;
const _listeners = new Set<() => void>();

/** Abort all in-flight session work and start a fresh epoch. */
export function bumpSessionEpoch(): void {
  _controller.abort();
  _controller = new AbortController();
  _epoch += 1;
  for (const l of _listeners) l();
}

/** AbortSignal valid for the current session. Aborted on the next bump. */
export function getSessionSignal(): AbortSignal {
  return _controller.signal;
}

/** Monotonic counter — useful for re-checking "am I still relevant?" inside async work. */
export function getSessionEpoch(): number {
  return _epoch;
}

/** React hook: re-renders consumers when the session epoch bumps. */
export function useSessionEpoch(): number {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _epoch,
    () => _epoch,
  );
}

/**
 * React hook: returns the *current* session AbortSignal, rebound when the
 * epoch bumps. Hooks that pass this signal into a `nostr.query` get
 * automatic cancellation on account switch.
 */
export function useSessionSignal(): AbortSignal {
  useSessionEpoch(); // subscribes; the signal returned is always fresh
  return _controller.signal;
}
