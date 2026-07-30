/**
 * useUnresolvedRetry — retries note references that are on screen and unresolved.
 *
 * Two triggers, one scheduler:
 *   1. every SWEEP_INTERVAL_MS (30s), and
 *   2. whenever new notes are fetched (autofetch tick or a manual "Newer"),
 *      via the returned `sweep()`.
 *
 * Both go through `shouldSweep` (@core/unresolvedSweep), which is what makes
 * "must not overlap another attempt" actually hold: a fetch that lands next to a
 * tick is refused as in-flight or too-soon rather than doubling the work. It
 * also enforces the "2 or more unresolved" threshold and the hidden-tab guard.
 *
 * Replaces useRetryFailedNotes, which fired once 15 seconds after mount and
 * never again — so anything that failed later, or failed that one retry, stayed
 * a grey placeholder until the app was reloaded.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  shouldSweep,
  selectSweepBatch,
  SWEEP_INTERVAL_MS,
  SWEEP_STAGGER_MS,
} from '@core/unresolvedSweep';
import { getUnresolvedIds, unresolvedCount } from '@/lib/failedNotes';
import { forgetParentMiss } from '@/hooks/useParentNotes';
import { debugLog } from '@/lib/debug';

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
      hidden: document.visibilityState === 'hidden',
      now: Date.now(),
      lastSweepAt: lastSweepAtRef.current,
    });
    if (!decision.sweep) return;

    const batch = selectSweepBatch(getUnresolvedIds());
    if (batch.length === 0) return;

    inFlightRef.current = true;
    lastSweepAtRef.current = Date.now();
    debugLog(`[unresolvedRetry] sweeping ${batch.length} of ${unresolvedCount()} unresolved`);

    // Drop the NEGATIVE cache for the whole batch up front. `forgetParentMiss`
    // clears the decayed miss record so lookups actually go back out to the
    // relays — and it must cover every id BEFORE the batched parent query
    // refetches, or the ids still inside their cooldown are skipped by its
    // shouldRetry gate and the sweep silently does nothing for them.
    //
    // Deliberately NOT clearing the event cache: it holds HITS, not misses,
    // and the entry is very often exactly what makes the retry succeed —
    // the thread view caches events it resolved, and the feed's NoteLink
    // reads that cache first. Clearing it threw away the one piece of
    // evidence that the note exists, so a retry after opening the thread
    // put the app straight back to "not found".
    for (const noteId of batch) forgetParentMiss(noteId);

    // ONE family invalidation for the batched reply-parent query (its key is a
    // signature of the whole request set, so the prefix match re-runs it once
    // for every id at once). This used to run inside the per-id stagger loop —
    // up to 40 refetches of the same query per sweep, which fed the very relay
    // congestion the sweep exists to recover from.
    queryClient.invalidateQueries({ queryKey: ['parent-notes'] });

    // Per-id refetches (quoted notes + singular parents), staggered so they
    // don't burst — but capped so a full batch always fits INSIDE the sweep
    // interval. At the old fixed 500ms, 40 ids took 19.5s against a 15s
    // interval, so the in-flight guard was still held when the next tick
    // arrived and every other sweep was refused.
    const staggerMs = Math.min(
      SWEEP_STAGGER_MS,
      Math.max(50, Math.floor((SWEEP_INTERVAL_MS - 2000) / batch.length)),
    );
    batch.forEach((noteId, i) => {
      timersRef.current.push(setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        // The SINGULAR key (useParentNote) was never invalidated — a stuck
        // single-parent lookup sat out every sweep.
        queryClient.invalidateQueries({ queryKey: ['parent-note', noteId] });
        // Release the guard after the last one is dispatched.
        if (i === batch.length - 1) inFlightRef.current = false;
      }, i * staggerMs));
    });
  }, [queryClient]);

  // The interval trigger.
  useEffect(() => {
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sweep]);

  // Sweep on return to the foreground: references that failed while the app was
  // hidden (or while the machine was asleep) are exactly the stale ones, and the
  // hidden guard means no sweep ran during that time.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') sweep();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [sweep]);

  // Cancel pending staggered retries on unmount, and release the guard so a
  // remount doesn't inherit a stuck in-flight flag.
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
