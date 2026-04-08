import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { type NostrEvent } from '@nostrify/nostrify';
import { fetchEventWithOutbox } from '@/lib/fetchEvent';

// Shared cache for parent notes (persists across hook instances)
const parentNoteCache = new Map<string, NostrEvent>();

// Track IDs that failed first-pass fetch so we can retry them
const failedFirstPass = new Set<string>();

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

  // Normalize to ParentRequest objects
  const normalized: ParentRequest[] = requests.map(r =>
    typeof r === 'string' ? { eventId: r } : r
  );

  const uniqueRequests = Array.from(
    new Map(normalized.filter(r => r.eventId?.length > 0).map(r => [r.eventId, r])).values()
  );
  const uniqueIds = uniqueRequests.map(r => r.eventId);
  const cacheKey = uniqueIds.sort().join(',');
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
          const events = await nostr.query(
            [{ ids: uncachedIds }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }
          );
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
    }, 3000);

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
