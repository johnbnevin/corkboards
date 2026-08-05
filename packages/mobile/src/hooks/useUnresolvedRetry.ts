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
import { getUnresolvedIds, unresolvedCount, recordSweepAttempts } from '@core/failedNotes';
import { forgetParentMiss } from './useParentNotes';

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
    // Count the attempt BEFORE the refetches run: ids that keep failing climb
    // toward MAX_SWEEP_ATTEMPTS and drop out of future batches, and the
    // fewest-attempts-first ordering of getUnresolvedIds rotates the batch
    // instead of retrying the same first N forever.
    recordSweepAttempts(batch);

    // Drop the NEGATIVE cache for the whole batch BEFORE any refetch — ids
    // still inside their miss cooldown are otherwise skipped by the parent
    // query's shouldRetry gate, making the sweep a silent no-op for exactly
    // the ids it exists to revive. (Mobile never cleared it at all; parity
    // with web.)
    for (const noteId of batch) forgetParentMiss(noteId);

    // ONE family invalidation for the batched reply-parent query — per-id
    // invalidations re-ran the same query up to 40 times per sweep.
    queryClient.invalidateQueries({ queryKey: ['parent-notes'] });

    // Per-id refetches, staggered and sized so a batch occupies only a
    // fraction of the interval (~6s per 30s with MAX_PER_SWEEP=12). The old
    // 40-per-15s settings ran an ~85% duty cycle and owned the shared socket
    // budget, which starved cloud-backup discovery AND the sweep's own outbox
    // lookups — a retry loop that prevented its own success.
    const staggerMs = Math.min(
      SWEEP_STAGGER_MS,
      Math.max(50, Math.floor((SWEEP_INTERVAL_MS - 2000) / batch.length)),
    );
    batch.forEach((noteId, i) => {
      timersRef.current.push(setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        queryClient.invalidateQueries({ queryKey: ['parent-note', noteId] });
        if (i === batch.length - 1) inFlightRef.current = false;
      }, i * staggerMs));
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
