/**
 * useAutoFetch — periodic background "load newer notes" with safe gating.
 *
 * Three guards prevent relay-hammering:
 *   1. The autofetch toggle (when off, the interval is unmounted)
 *   2. `document.visibilityState === 'hidden'` — never fetch when the tab
 *      is in the background. (One real-world incident: 231 fetch failures
 *      overnight when this guard was missing.)
 *   3. `isLoadingRef.current` — skip if a previous fetch is still in flight
 *
 * Also fires on tab switches (after a short settle delay).
 *
 * Extracted from MultiColumnClient so the loop logic can be unit-tested
 * and the autofetch-storm class of bugs has a single home.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface UseAutoFetchOptions {
  /** Whether autofetch is enabled (typically per-tab + global setting). */
  enabled: boolean;
  /** Interval in seconds between fetches. */
  intervalSecs: number;
  /** Active tab id — used to retrigger after switches. */
  activeTab: string;
  /** Whether anything else (manual load) is currently in-flight. */
  isLoadingAny: boolean;
  /** Fetch newer notes for the currently active feed. */
  loadNewer: () => void;
}

export interface UseAutoFetchResult {
  /** Timestamp (ms) of the most recent autofetch tick — useful for "last refreshed N ago" UI. */
  lastAutofetchTime: number;
}

export function useAutoFetch({
  enabled,
  intervalSecs,
  activeTab,
  isLoadingAny,
  loadNewer,
}: UseAutoFetchOptions): UseAutoFetchResult {
  const queryClient = useQueryClient();

  // Keep latest references in refs so the long-lived interval closure doesn't
  // capture stale loadNewer / isLoadingAny values.
  //
  // Eventual-consistency caveat: `isLoadingAny` is observed via the ref inside
  // the interval tick, not via the dep array. If `isLoadingAny` flips just
  // before a tick, the tick sees the latest value (refs update on every render).
  // If it flips between two ticks, the next tick catches it — there is up to
  // one `intervalSecs` of latency between an `isLoadingAny` change and the
  // interval respecting it. Including `isLoadingAny` in the dep array would
  // tear down + recreate the interval on every load, which causes scheduling
  // jitter and was the bug this hook was extracted to prevent.
  const loadNewerRef = useRef(loadNewer);
  loadNewerRef.current = loadNewer;
  const isLoadingRef = useRef(isLoadingAny);
  isLoadingRef.current = isLoadingAny;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const tickRef = useRef(0);
  const [lastAutofetchTime, setLastAutofetchTime] = useState<number>(0);

  // The main interval — re-created when enabled / intervalSecs change.
  useEffect(() => {
    if (!enabled) return;
    tickRef.current = 0;
    if (!isLoadingRef.current) {
      loadNewerRef.current();
      setLastAutofetchTime(Date.now());
    }
    const intervalMs = intervalSecs * 1000;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (!enabledRef.current || isLoadingRef.current) return;
      loadNewerRef.current();
      setLastAutofetchTime(Date.now());
      if (++tickRef.current % 2 === 0) {
        queryClient.invalidateQueries({ queryKey: ['notification-count'] });
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalSecs, queryClient]);

  // Fire on tab switch (after small settle delay).
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
