/**
 * Session-scoped AbortController for race-free account switching.
 *
 * Web mirror of mobile's `useSessionAbort` — keeps the API the same across
 * platforms so shared hooks don't need to branch.
 *
 * On web the dominant safety mechanism is the hard `window.location.reload()`
 * in `useAccountIsolation` after `switchActiveUser`, which kills all in-flight
 * work implicitly. This module exists for two reasons:
 *
 *   1. Defence in depth — call `bumpSessionEpoch()` *before* the reload so
 *      any sibling tabs (BroadcastChannel listeners, service workers) that
 *      observe the user change can also cancel their work without waiting
 *      for the reload to land.
 *   2. Soft logins / nostr-login session reuse where no reload happens.
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
  useSessionEpoch();
  return _controller.signal;
}
