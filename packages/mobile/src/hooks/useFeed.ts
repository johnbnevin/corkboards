import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { FALLBACK_RELAYS } from '../lib/NostrProvider';
import { FEED_PAGE_SIZE_MOBILE, FEED_KINDS } from '@core/feedConstants';
import { dedupBatch, initialUntilCursor, PAGINATION_MAX_ITERATIONS } from '@core/paginationCore';
import { fnv1a32 } from '@core/hashCore';

/**
 * React Query cache key for an author set.
 *
 * The key used to be `authors.slice(0, 10).join(',')`. Every corkboard built
 * from the same first ten authors — which is the normal case when boards are
 * created by adding to a copy of an existing one, and the guaranteed case for
 * two boards over the same follow list with different extras — collided onto a
 * single cache entry, so switching between them showed the other board's notes
 * and `useFeedLoadMore` appended pages of one board into the other. Digest the
 * FULL list (order-independent, so a reordered but identical set still hits)
 * and carry the length, which makes an accidental collision vanishingly rare
 * and a silent one impossible to produce by prefix alone.
 */
export function authorsCacheKey(authors: string[]): string {
  if (authors.length === 0) return 'global';
  // XOR-fold per-author hashes: commutative, so it doesn't depend on ordering,
  // and it doesn't require sorting a 5000-element array on every render.
  // fnv1a32 returns 8 hex chars; parse back to fold numerically.
  let digest = 0;
  for (const author of authors) digest = (digest ^ parseInt(fnv1a32(author), 16)) >>> 0;
  return `${authors.length}:${digest.toString(36)}`;
}

/**
 * Fetch recent notes from a set of authors.
 * Falls back to global relay feed when no authors are provided.
 */
export function useFeed(authors: string[] = []) {
  const { nostr } = useNostr();

  return useQuery<NostrEvent[]>({
    queryKey: ['mobile-feed', authorsCacheKey(authors)],
    queryFn: async () => {
      const filter = {
        kinds: FEED_KINDS.filter(k => k === 1 || k === 6) as number[],
        limit: FEED_PAGE_SIZE_MOBILE,
        ...(authors.length > 0 ? { authors } : {}),
      };

      const events: NostrEvent[] = [];
      const seenIds = new Set<string>();

      if (authors.length === 0) {
        // Global mode: query each fallback relay directly (per-relay routing,
        // same pattern as SavedScreen) instead of N identical pool queries.
        await Promise.allSettled(
          FALLBACK_RELAYS.slice(0, 3).map(async (url) => {
            try {
              const relay = nostr.relay(url);
              const relayEvents = await relay.query([filter], { signal: AbortSignal.timeout(8000) });
              for (const ev of relayEvents) {
                if (!seenIds.has(ev.id)) {
                  seenIds.add(ev.id);
                  events.push(ev);
                }
              }
            } catch {
              // relay timeout/error — skip
            }
          })
        );
      } else {
        const results = await nostr.query([filter], { signal: AbortSignal.timeout(10000) });
        for (const ev of results) {
          if (!seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            events.push(ev);
          }
        }
      }

      // Sort newest first
      return events.sort((a, b) => b.created_at - a.created_at).slice(0, FEED_PAGE_SIZE_MOBILE);
    },
    staleTime: 2 * 60_000,
    retry: 1,
  });
}

/**
 * Pagination helper for mobile feeds. Wraps the shared @core/paginationCore
 * iterative-undismissed-count loop and writes results into the same React
 * Query cache key as `useFeed` so the list grows in place.
 *
 * Callers wire this into FlatList's onEndReached. The hook itself is
 * stateful: it tracks `isLoading` so the UI can render a footer spinner
 * without re-renders cascading through the feed.
 */
export interface UseFeedLoadMoreOptions {
  authors: string[];
  /** Lookup for dismissed note IDs — iteration stops when `count` undismissed are added. */
  isDismissed?: (noteId: string) => boolean;
  /** Notification when each batch finishes — used for "+N more" UI affordances. */
  onLoaded?: (addedCount: number, undismissedCount: number) => void;
}

export function useFeedLoadMore({ authors, isDismissed, onLoaded }: UseFeedLoadMoreOptions) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const inFlightRef = useRef(false);

  // Memoize the cache-key signature so the useCallback deps stay "simple
  // expressions" per react-hooks/use-memo rule, and so the cacheKey identity
  // is stable when authors are unchanged.
  const authorsKey = useMemo(() => authorsCacheKey(authors), [authors]);
  const cacheKey = useMemo(() => ['mobile-feed', authorsKey] as const, [authorsKey]);

  const loadMoreByCount = useCallback(async (count: number) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoading(true);
    try {
      const existing = (queryClient.getQueryData(cacheKey) as NostrEvent[] | undefined) ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      let untilCursor = initialUntilCursor(existing);
      const allTrulyNew: NostrEvent[] = [];
      let undismissedAdded = 0;

      for (let iter = 0; iter < PAGINATION_MAX_ITERATIONS && undismissedAdded < count; iter++) {
        const filter = {
          kinds: FEED_KINDS.filter(k => k === 1 || k === 6) as number[],
          limit: count,
          until: untilCursor,
          ...(authors.length > 0 ? { authors } : {}),
        };
        const raw = await nostr.query([filter], { signal: AbortSignal.timeout(8000) });
        if (raw.length === 0) break;

        const { trulyNew, oldestReturned } = dedupBatch(raw, existingIds);
        if (oldestReturned >= untilCursor) break; // no cursor progress
        untilCursor = oldestReturned - 1;

        for (const n of trulyNew) {
          existingIds.add(n.id);
          allTrulyNew.push(n);
          if (!isDismissed || !isDismissed(n.id)) undismissedAdded++;
          if (undismissedAdded >= count) break;
        }
      }

      if (allTrulyNew.length > 0) {
        // Merge and re-sort newest-first. Intentionally NOT truncated to
        // MAX_RETAINED_NOTES: these are older notes the user explicitly paged
        // for, and a newest-first cap would slice them straight back off. The
        // growth-over-time source is autofetch (which replaces this cache
        // wholesale rather than appending), and FlatList virtualizes rendering,
        // so the live cost here stays bounded. Mirrors web's MultiColumnClient.
        const merged = [...existing, ...allTrulyNew].sort((a, b) => b.created_at - a.created_at);
        queryClient.setQueryData(cacheKey, merged);
      }
      onLoaded?.(allTrulyNew.length, undismissedAdded);
    } catch (err) {
      if (__DEV__) console.warn('[useFeedLoadMore] error:', err);
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
    }
  }, [nostr, queryClient, authors, cacheKey, isDismissed, onLoaded]);

  return { loadMoreByCount, isLoading };
}

/**
 * Fetch the contact list (follows) for a pubkey.
 */
export function useContacts(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<string[]>({
    queryKey: ['contacts', pubkey],
    queryFn: async () => {
      if (!pubkey) return [];
      const [event] = await nostr.query(
        [{ kinds: [3], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(8000) }
      );
      if (!event) return [];
      return event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
    },
    enabled: !!pubkey,
    staleTime: 5 * 60_000,
  });
}
