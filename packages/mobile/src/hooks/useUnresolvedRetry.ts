/**
 * useUnresolvedRetry — retries note references that are on screen and unresolved.
 *
 * Port of packages/web/src/hooks/useUnresolvedRetry.ts. Keep the two in step;
 * the policy itself (threshold, interval, batch cap) is shared in
 * @core/unresolvedSweep so they cannot drift.
 *
 * Two triggers, one scheduler:
 *   1. every SWEEP_INTERVAL_MS (30s), and
 *   2. whenever new notes are fetched, via the returned `sweep()`.
 *
 * Both go through `shouldSweep`, which is what makes "must not overlap another
 * attempt" hold: a fetch that lands next to a tick is refused as in-flight or
 * too-soon rather than doubling the work.
 *
 * Replaces useRetryFailedNotes, which fired once 15 seconds after mount and
 * never again.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  shouldSweep,
  selectSweepBatch,
  SWEEP_INTERVAL_MS,
  SWEEP_STAGGER_MS,
} from '@core/unresolvedSweep';
import { getUnresolvedIds, unresolvedCount } from '@core/failedNotes';

export interface UseUnresolvedRetryResult {
  /** Attempt a sweep now. Refused unless the shared policy allows it. */
  sweep: () => void;
}

export function useUnresolvedRetry(): UseUnresolvedRetryResult {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);
  const lastSweepAtRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const sweep = useCallback(() => {
    const decision = shouldSweep({
      unresolvedCount: unresolvedCount(),
      inFlight: inFlightRef.current,
      // The mobile equivalent of the hidden-tab guard: never retry from the
      // background, where the OS may suspend us mid-flight anyway.
      hidden: AppState.currentState !== 'active',
      now: Date.now(),
      lastSweepAt: lastSweepAtRef.current,
    });
    if (!decision.sweep) return;

    const batch = selectSweepBatch(getUnresolvedIds());
    if (batch.length === 0) return;

    inFlightRef.current = true;
    lastSweepAtRef.current = Date.now();

    batch.forEach((noteId, i) => {
      timersRef.current.push(setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        // Parent lookups live under their own keys (parity with web).
        queryClient.invalidateQueries({ queryKey: ['parent-notes'] });
        queryClient.invalidateQueries({ queryKey: ['parent-note', noteId] });
        if (i === batch.length - 1) inFlightRef.current = false;
      }, i * SWEEP_STAGGER_MS));
    });
  }, [queryClient]);

  useEffect(() => {
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sweep]);

  // Sweep on return to the foreground — references that failed while
  // backgrounded are exactly the stale ones, and the guard above means no sweep
  // ran while we were away.
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'active') sweep();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [sweep]);

  useEffect(() => {
    const timers = timersRef;
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      inFlightRef.current = false;
    };
  }, []);

  return { sweep };
}
