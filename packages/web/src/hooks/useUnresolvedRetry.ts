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

    batch.forEach((noteId, i) => {
      timersRef.current.push(setTimeout(() => {
        // Drop the NEGATIVE cache only. `forgetParentMiss` clears the decayed
        // miss record so the lookup actually goes back out to the relays.
        //
        // Deliberately NOT clearing the event cache: it holds HITS, not misses,
        // and the entry is very often exactly what makes the retry succeed —
        // the thread view caches events it resolved, and the feed's NoteLink
        // reads that cache first. Clearing it threw away the one piece of
        // evidence that the note exists, so a retry after opening the thread
        // put the app straight back to "not found".
        forgetParentMiss(noteId);
        queryClient.invalidateQueries({ queryKey: ['note', noteId] });
        // Replied-to parents live under a different key than quoted notes, and
        // the key is a signature of the whole request set rather than one id —
        // so this invalidates the family by prefix. Cheap: with the miss decay
        // cleared above, the refetch only re-queries ids that are still absent.
        queryClient.invalidateQueries({ queryKey: ['parent-notes'] });
        // Release the guard after the last one is dispatched.
        if (i === batch.length - 1) inFlightRef.current = false;
      }, i * SWEEP_STAGGER_MS));
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
