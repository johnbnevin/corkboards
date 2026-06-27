import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { type NostrEvent } from '@nostrify/nostrify';
import { fetchEventWithOutbox } from '@/lib/fetchEvent';

// Shared cache for parent notes (persists across hook instances)
const parentNoteCache = new Map<string, NostrEvent>();

// Track IDs that failed first-pass fetch so we can retry them
const failedFirstPass = new Set<string>();

// Limit concurrent first-pass pool queries to avoid opening too many relay connections at once.
const MAX_CONCURRENT_POOL_QUERIES = 6;

// First-pass pool query ceiling. EOSE usually resolves well before this; the
// ceiling just bounds the worst case before missing IDs fall to the second pass.
const FIRST_PASS_TIMEOUT_MS = 6000;
// Delay before the second (outbox-discovery) pass. Kept short so reply parents
// that the first pass missed appear quickly instead of seconds later.
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

      // Find which IDs need to be fetched (not in cache)
      const uncachedIds = uniqueIds.filter(id => !parentNoteCache.has(id));

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
            parentNoteCache.set(event.id, event);
          }
        } catch {
          // Pool query failed — all IDs become candidates for second pass
        }

        // Track which IDs are still missing after pool query
        for (const id of uncachedIds) {
          if (!parentNoteCache.has(id)) {
            failedFirstPass.add(id);
          } else {
            failedFirstPass.delete(id);
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

    const missing = uniqueRequests.filter(r => failedFirstPass.has(r.eventId));
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
          parentNoteCache.set(missing[i].eventId, results[i]!);
          failedFirstPass.delete(missing[i].eventId);
          found++;
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
  failedFirstPass.clear();
}
