/**
 * useAutoFetch — periodic background feed refresh with safe gating.
 *
 * Mobile counterpart of packages/web/src/hooks/useAutoFetch.ts. Mobile had the
 * `AUTOFETCH_INTERVAL_SECS` setting wired into the settings screen but nothing
 * consuming it: the feed only ever updated on pull-to-refresh, while web
 * refreshed on an interval and on tab focus. This closes that gap using the same
 * three guards that web uses, so the class of relay-storm bugs the web hook was
 * extracted to prevent can't reappear here:
 *
 *   1. The autofetch toggle (when off, the interval is never created)
 *   2. App is foregrounded — `AppState.currentState === 'active'`. This is the
 *      React Native analogue of web's `document.visibilityState` guard, and it
 *      matters more here: a backgrounded phone app left running overnight would
 *      otherwise keep hammering relays on cellular.
 *   3. `isLoadingRef.current` — skip if a fetch is already in flight
 *
 * Also fires promptly on foreground (resume from background) and on tab switch,
 * matching web's visibilitychange + tab-switch triggers.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export interface UseAutoFetchOptions {
  /** Whether autofetch is enabled (user setting). */
  enabled: boolean;
  /** Interval in seconds between fetches. */
  intervalSecs: number;
  /** Active tab id — used to retrigger after switches. */
  activeTab: string;
  /** Whether anything else (manual refresh / load more) is currently in-flight. */
  isLoadingAny: boolean;
  /** Refresh the currently active feed. */
  loadNewer: () => void;
}

export interface UseAutoFetchResult {
  /** Timestamp (ms) of the most recent autofetch tick — for "last refreshed" UI. */
  lastAutofetchTime: number;
}

export function useAutoFetch({
  enabled,
  intervalSecs,
  activeTab,
  isLoadingAny,
  loadNewer,
}: UseAutoFetchOptions): UseAutoFetchResult {
  // Keep the latest values in refs so the long-lived interval closure doesn't
  // capture stale ones.
  //
  // Eventual-consistency caveat (same as web): `isLoadingAny` is observed via the
  // ref inside the tick, not via the dep array. If it flips between two ticks,
  // the next tick catches it — up to one `intervalSecs` of latency. Putting it in
  // the dep array would tear down and recreate the interval on every load, which
  // causes scheduling jitter; that is the bug this shape exists to avoid.
  //
  // The assignments below are the "latest ref" pattern and are intentionally in
  // the render phase, byte-for-byte matching the web hook. `react-hooks/refs`
  // flags render-phase ref writes, but moving these into an effect would make
  // the values lag by one commit — and the interval created in the effect below
  // fires an immediate first tick that reads `isLoadingRef` before any
  // post-commit effect could have populated it. Keeping the two platforms
  // identical here also matters more than silencing the rule: the whole reason
  // this logic is a shared-shape hook is that autofetch bugs were platform-drift
  // bugs.
  /* eslint-disable react-hooks/refs */
  const loadNewerRef = useRef(loadNewer);
  loadNewerRef.current = loadNewer;
  const isLoadingRef = useRef(isLoadingAny);
  isLoadingRef.current = isLoadingAny;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  /* eslint-enable react-hooks/refs */

  const [lastAutofetchTime, setLastAutofetchTime] = useState(0);

  // The main interval — re-created when enabled / intervalSecs change.
  useEffect(() => {
    if (!enabled) return;
    if (!isLoadingRef.current) {
      loadNewerRef.current();
      setLastAutofetchTime(Date.now());
    }
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      if (!enabledRef.current || isLoadingRef.current) return;
      loadNewerRef.current();
      setLastAutofetchTime(Date.now());
    }, intervalSecs * 1000);
    return () => clearInterval(timer);
  }, [enabled, intervalSecs]);

  // Fire promptly when the app returns to the foreground, so the feed
  // repopulates without waiting for the next tick.
  useEffect(() => {
    if (!enabled) return;
    const onChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      if (!enabledRef.current || isLoadingRef.current) return;
      loadNewerRef.current();
      setLastAutofetchTime(Date.now());
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [enabled]);

  // Fire on tab switch (after a small settle delay, as on web).
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (enabledRef.current && activeTab !== prevTabRef.current) {
      prevTabRef.current = activeTab;
      const t = setTimeout(() => {
        if (enabledRef.current && !isLoadingRef.current) loadNewerRef.current();
      }, 500);
      return () => clearTimeout(t);
    }
    prevTabRef.current = activeTab;
  }, [activeTab]);

  return { lastAutofetchTime };
}
