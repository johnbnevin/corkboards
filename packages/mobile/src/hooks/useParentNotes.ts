/**
 * useParentNotes — Batch fetch parent notes with two-pass outbox model.
 *
 * Port of packages/web/src/hooks/useParentNotes.ts for mobile.
 */
import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { type NostrEvent } from '@nostrify/nostrify';
import { fetchEventWithOutbox } from '../lib/fetchEvent';
import { MissCache } from '@core/missCache';

const parentNoteCache = new Map<string, NostrEvent>();

/**
 * Negative cache for IDs the fast batch pass didn't find. (Mirrors web.)
 *
 * This was a plain `Set<string>` that only ever grew: an id was added when the
 * first pass missed and removed only if a later pass found the event, so any
 * genuinely-unreachable parent stayed in it for the life of the process. The
 * second-pass effect below re-reads it whenever `query.data` changes — every
 * feed update — so each of those re-armed a full second pass over every
 * permanently missing id, forever, worsening as the feed grew.
 *
 * MissCache keeps the retry but makes it decay: exponential cooldown per
 * consecutive miss, a hard attempt ceiling, and a bounded entry count.
 */
const parentMisses = new MissCache({
  maxEntries: 2000,
  baseCooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  maxAttempts: 3,
});

/**
 * Ids the most recent FIRST pass attempted and did not resolve — the second
 * pass's actual work queue. (Mirrors web.)
 *
 * The second-pass filter used to be `hasMissed(id) && shouldRetry(id)`, which
 * is self-defeating right after a first pass: a pass that TIMED OUT records no
 * miss (so `hasMissed` is false), and a pass that reached EOSE and missed just
 * started a 30s cooldown (so `shouldRetry` is false). Either way the 800ms
 * escalation found nothing to do, and parents only got author-relay discovery
 * if some later refetch happened after the cooldown. An id in this set earned
 * exactly one prompt escalation by being attempted by a first pass (itself
 * gated by the miss cooldown); the attempt ceiling still applies.
 */
const pendingSecondPass = new Set<string>();

const MAX_CONCURRENT_POOL_QUERIES = 6;
/** Max individual outbox lookups fired by one second pass. */
const MAX_SECOND_PASS_PER_ROUND = 12;
// First-pass ceiling + short second-pass delay so reply parents that the fast
// batch query missed appear quickly instead of seconds later. (Mirrors web.)
const FIRST_PASS_TIMEOUT_MS = 6000;
const SECOND_PASS_DELAY_MS = 800;
let _activePoolQueries = 0;
const _poolQueryQueue: Array<() => void> = [];

function withPoolQueryLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (_activePoolQueries < MAX_CONCURRENT_POOL_QUERIES) {
    _activePoolQueries++;
    return fn().finally(() => {
      _activePoolQueries--;
      _poolQueryQueue.shift()?.();
    });
  }
  return new Promise<T>((resolve, reject) => {
    _poolQueryQueue.push(() => {
      _activePoolQueries++;
      fn().then(resolve, reject).finally(() => {
        _activePoolQueries--;
        _poolQueryQueue.shift()?.();
      });
    });
  });
}

interface ParentRequest {
  eventId: string;
  hints?: string[];
  authorPubkey?: string;
}

export function useParentNote(eventId: string | undefined) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['parent-note', eventId],
    queryFn: async () => {
      if (!eventId) return null;
      if (parentNoteCache.has(eventId)) return parentNoteCache.get(eventId)!;

      const result = await fetchEventWithOutbox(eventId, nostr);
      if (result) parentNoteCache.set(eventId, result);
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: !!eventId,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

export function useParentNotes(requests: (ParentRequest | string)[]) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const secondPassScheduled = useRef(false);

  // Stable content signature of the request set. The memos below (and the
  // second-pass effect) key off this so they only recompute when the actual IDs
  // change — not on every render. Previously these arrays were rebuilt every
  // render, so the second-pass effect (which lists uniqueRequests as a dep)
  // re-ran constantly, arming-and-cancelling its timer and leaving genuinely-
  // missing parents blank. (Mirrors web.)
  const cacheKey = useMemo(() => {
    const ids = requests
      .map(r => (typeof r === 'string' ? r : r?.eventId))
      .filter((id): id is string => !!id && id.length > 0);
    return Array.from(new Set(ids)).sort().join(',');
  }, [requests]);

  const uniqueRequests = useMemo<ParentRequest[]>(() => {
    const normalized: ParentRequest[] = requests.map(r =>
      typeof r === 'string' ? { eventId: r } : r
    );
    return Array.from(
      new Map(normalized.filter(r => r.eventId?.length > 0).map(r => [r.eventId, r])).values()
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on cacheKey, the content signature of `requests`
  }, [cacheKey]);

  const uniqueIds = useMemo(() => uniqueRequests.map(r => r.eventId), [uniqueRequests]);
  const queryKey = useMemo(() => ['parent-notes', cacheKey], [cacheKey]);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (uniqueRequests.length === 0) {
        return {} as Record<string, NostrEvent | null>;
      }

      // Not cached, and not inside a miss cooldown. Without the second
      // condition the FIRST pass re-queried every known-unreachable id on every
      // feed update too, not just the second.
      const uncachedIds = uniqueIds.filter(
        id => !parentNoteCache.has(id) && parentMisses.shouldRetry(id),
      );

      if (uncachedIds.length > 0) {
        let passCompleted = false;
        try {
          const events = await withPoolQueryLimit(() => {
            if (signal.aborted) return Promise.resolve([] as NostrEvent[]);
            return nostr.query(
              [{ ids: uncachedIds }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(FIRST_PASS_TIMEOUT_MS)]) }
            );
          });
          passCompleted = true;
          for (const event of events) {
            parentNoteCache.set(event.id, event);
          }
        } catch {
          // Pool query failed
        }

        // A query that timed out or aborted is evidence of congestion, not of
        // absence — recording misses for it retired reachable parents for up
        // to 15 minutes. Only a completed query gets to advance the miss decay
        // (mirrors web).
        for (const id of uncachedIds) {
          if (parentNoteCache.has(id)) {
            parentMisses.recordHit(id);
            pendingSecondPass.delete(id);
          } else {
            if (passCompleted) parentMisses.recordMiss(id);
            // Attempted just now and still missing — timed out or genuinely
            // absent, the second pass escalates either way. (Mirrors web.)
            pendingSecondPass.add(id);
          }
        }
      }

      const result: Record<string, NostrEvent | null> = {};
      for (const id of uniqueIds) {
        result[id] = parentNoteCache.get(id) || null;
      }
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: uniqueIds.length > 0,
    placeholderData: keepPreviousData,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  // Second pass: retry failed IDs individually with full outbox discovery
  //
  // Keyed on dataUpdatedAt, NOT data identity. When a retry sweep re-runs the
  // batched query and every id misses again, the result map is deep-equal to
  // the previous one, so structural sharing hands back the SAME object — an
  // effect keyed on `query.data` never re-fires, and the escalation below (the
  // lookup that actually finds these events) ran once at mount and never
  // again. dataUpdatedAt advances on every completed fetch regardless.
  const dataUpdatedAt = query.dataUpdatedAt;
  useEffect(() => {
    if (secondPassScheduled.current) return;
    if (!query.data) return;

    // Two ways in: an id the first pass JUST attempted and left unresolved
    // (pendingSecondPass — retried now even inside its cooldown, since the
    // cooldown was started by that same first pass), or an older miss whose
    // cooldown has elapsed. Capped per round so a large feed can't fire one
    // lookup per missing parent at once. (Mirrors web.)
    const missing = uniqueRequests
      .filter(r => pendingSecondPass.has(r.eventId)
        ? !parentMisses.isExhausted(r.eventId)
        : (parentMisses.hasMissed(r.eventId) && parentMisses.shouldRetry(r.eventId)))
      .slice(0, MAX_SECOND_PASS_PER_ROUND);
    if (missing.length === 0) return;

    secondPassScheduled.current = true;
    let mounted = true;
    const timer = setTimeout(async () => {
      // Consumed exactly when the escalation actually fires. If the timer is
      // cancelled (unmount, feed change) the ids stay pending for the next run.
      for (const r of missing) pendingSecondPass.delete(r.eventId);
      let found = 0;
      const results = await Promise.all(
        missing.map(r =>
          fetchEventWithOutbox(r.eventId, nostr, {
            hints: r.hints,
            authorPubkey: r.authorPubkey,
          }).catch(() => null)
        )
      );

      if (!mounted) return;

      for (let i = 0; i < missing.length; i++) {
        if (results[i]) {
          parentNoteCache.set(missing[i].eventId, results[i]!);
          parentMisses.recordHit(missing[i].eventId);
          found++;
        } else {
          // Still not found — advance the backoff so the next round waits
          // longer, and the attempt ceiling eventually stops the retries.
          parentMisses.recordMiss(missing[i].eventId);
        }
      }

      if (found > 0) {
        queryClient.invalidateQueries({ queryKey });
      }
      secondPassScheduled.current = false;
    }, SECOND_PASS_DELAY_MS);

    return () => {
      mounted = false;
      clearTimeout(timer);
      secondPassScheduled.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataUpdatedAt stands in for query.data (see above)
  }, [dataUpdatedAt, uniqueRequests, nostr, queryClient, queryKey]);

  return query;
}

export function isParentNoteCached(eventId: string): boolean {
  return parentNoteCache.has(eventId);
}

export function getCachedParentNote(eventId: string): NostrEvent | undefined {
  return parentNoteCache.get(eventId);
}

export function clearParentNoteCache(): void {
  parentNoteCache.clear();
  parentMisses.clear();
  pendingSecondPass.clear();
}

/** Store a parent event resolved by an out-of-band lookup (e.g. "Retry now"). */
export function cacheParentNote(id: string, event: NostrEvent): void {
  parentNoteCache.set(id, event);
  parentMisses.recordHit(id);
}

/** Clear one id's miss-decay so the next lookup goes back out to the relays. */
export function forgetParentMiss(eventId: string): void {
  parentMisses.recordHit(eventId);
}
