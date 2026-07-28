import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { type NostrEvent } from '@nostrify/nostrify';
import { fetchEventWithOutbox } from '@/lib/fetchEvent';
import { MissCache } from '@core/missCache';

// Shared cache for parent notes (persists across hook instances).
//
// BOUNDED. It was a plain unbounded Map: every reply the user ever scrolled
// past added a full event object (content, tags, sig) and nothing ever removed
// one, so a long autofetch session — the normal way this app is used — grew it
// until the tab was reloaded. `parentMisses` next to it is already bounded for
// exactly this reason; the hit cache needs the same treatment, and more so,
// because it stores whole events rather than counters.
const MAX_PARENT_NOTE_CACHE = 1500;
const parentNoteCache = new Map<string, NostrEvent>();

/** LRU insert: re-inserting moves a key to the end of Map iteration order. */
function cacheParentNote(id: string, event: NostrEvent): void {
  parentNoteCache.delete(id);
  while (parentNoteCache.size >= MAX_PARENT_NOTE_CACHE) {
    parentNoteCache.delete(parentNoteCache.keys().next().value!);
  }
  parentNoteCache.set(id, event);
}

/**
 * Negative cache for IDs the fast batch pass didn't find.
 *
 * This used to be a plain `Set<string>` that only ever grew: an id was added
 * when the first pass missed and removed only if a later pass found the event.
 * Any genuinely-unreachable parent — deleted, or living only on a relay we
 * don't talk to — therefore stayed in it for the life of the process.
 *
 * The second-pass effect below re-reads it whenever `query.data` changes, which
 * is every feed update: every autofetch tick, every "load newer", every tab
 * switch. So each of those re-armed a full second pass over every permanently
 * missing id, forever, and got worse as the feed grew. On desktop one
 * second-pass lookup opens roughly a dozen fresh TLS connections (pool fan-out
 * + NIP-65 discovery across all fallback relays + author relays), so a feed
 * with a few dozen unreachable parents became a standing load generator.
 *
 * MissCache keeps the retry — late-arriving data must still resolve — but makes
 * it decay: exponential cooldown per consecutive miss, a hard attempt ceiling,
 * and a bounded entry count.
 */
const parentMisses = new MissCache({
  maxEntries: 2000,
  baseCooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  maxAttempts: 3,
});

// Limit concurrent first-pass pool queries to avoid opening too many relay connections at once.
const MAX_CONCURRENT_POOL_QUERIES = 6;

// First-pass pool query ceiling. EOSE usually resolves well before this; the
// ceiling just bounds the worst case before missing IDs fall to the second pass.
const FIRST_PASS_TIMEOUT_MS = 6000;
// Delay before the second (outbox-discovery) pass. Kept short so reply parents
// that the first pass missed appear quickly instead of seconds later.
const SECOND_PASS_DELAY_MS = 800;
/** Max individual outbox lookups fired by one second pass. */
const MAX_SECOND_PASS_PER_ROUND = 12;
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

/**
 * Fetch a single parent note by event ID using outbox model.
 */
export function useParentNote(eventId: string | undefined) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['parent-note', eventId],
    queryFn: async () => {
      if (!eventId) return null;
      if (parentNoteCache.has(eventId)) return parentNoteCache.get(eventId)!;

      const result = await fetchEventWithOutbox(eventId, nostr);
      if (result) cacheParentNote(eventId, result);
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: !!eventId,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

/**
 * Batch fetch multiple parent notes.
 *
 * First pass: fast batch query via the NPool (uses built-in outbox routing).
 * Second pass (3s later): any IDs still missing are retried individually
 * via fetchEventWithOutbox which does full author-relay discovery.
 */
export function useParentNotes(requests: (ParentRequest | string)[]) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const secondPassScheduled = useRef(false);

  // Stable content signature of the request set. The memos below (and the
  // second-pass effect) key off this so they only recompute when the actual IDs
  // change — not on every render. Previously these arrays were rebuilt every
  // render, so the second-pass effect (which lists uniqueRequests as a dep)
  // re-ran constantly, arming-and-cancelling its timer and leaving genuinely-
  // missing parents blank.
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

      // Find which IDs need to be fetched: not cached, and not inside a miss
      // cooldown. Without the second condition the *first* pass re-queried every
      // known-unreachable id on every feed update too, not just the second.
      const uncachedIds = uniqueIds.filter(
        id => !parentNoteCache.has(id) && parentMisses.shouldRetry(id),
      );

      // First pass: fast batch query through the pool
      if (uncachedIds.length > 0) {
        try {
          const events = await withPoolQueryLimit(() => {
            if (signal.aborted) return Promise.resolve([] as NostrEvent[]);
            return nostr.query(
              [{ ids: uncachedIds }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(FIRST_PASS_TIMEOUT_MS)]) }
            );
          });
          for (const event of events) {
            cacheParentNote(event.id, event);
          }
        } catch {
          // Pool query failed — all IDs become candidates for second pass
        }

        // Track which IDs are still missing after pool query
        for (const id of uncachedIds) {
          if (!parentNoteCache.has(id)) {
            parentMisses.recordMiss(id);
          } else {
            parentMisses.recordHit(id);
          }
        }
      }

      // Build result map from cache
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
  useEffect(() => {
    if (secondPassScheduled.current) return;
    if (!query.data) return;

    // Only ids that have actually missed AND are out of cooldown. An id whose
    // cooldown is still running, or that has exhausted its attempts, is skipped
    // — that is what stops the standing retry storm.
    const missing = uniqueRequests
      .filter(r => parentMisses.hasMissed(r.eventId) && parentMisses.shouldRetry(r.eventId))
      // Bound a single pass regardless of feed size: a large feed used to fire
      // Promise.all over every missing parent at once, and each of those opens
      // ~a dozen sockets on desktop. Anything beyond the cap is picked up by a
      // later pass once these resolve.
      .slice(0, MAX_SECOND_PASS_PER_ROUND);
    if (missing.length === 0) return;

    secondPassScheduled.current = true;
    let mounted = true;
    const timer = setTimeout(async () => {
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
          cacheParentNote(missing[i].eventId, results[i]!);
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
  }, [query.data, uniqueRequests, nostr, queryClient, queryKey]);

  return query;
}

/**
 * Check if a parent note is already cached.
 */
export function isParentNoteCached(eventId: string): boolean {
  return parentNoteCache.has(eventId);
}

/**
 * Get a cached parent note (returns undefined if not cached).
 */
export function getCachedParentNote(eventId: string): NostrEvent | undefined {
  return parentNoteCache.get(eventId);
}

/**
 * Clear the parent note cache.
 */
export function clearParentNoteCache(): void {
  parentNoteCache.clear();
  parentMisses.clear();
}
