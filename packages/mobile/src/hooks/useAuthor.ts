/**
 * useAuthor — profile fetch with MMKV disk cache, background refresh,
 * and fallback relay logic. Mirrors web's useAuthor.ts.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NSchema as n } from '@nostrify/nostrify';
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { useNostr, FALLBACK_RELAYS } from '../lib/NostrProvider';
import { getCachedProfile, cacheProfile } from '../lib/cacheStore';

interface AuthorResult {
  event?: NostrEvent;
  metadata?: NostrMetadata;
}

interface NostrPool {
  query: (filters: unknown[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  relay: (url: string) => { query: (filters: unknown[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> };
}

const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h — keep in sync with web
const STALE_TIME = 24 * 60 * 60 * 1000;

async function fetchAuthorFromNetwork(
  pubkey: string,
  signal: AbortSignal,
  nostr: NostrPool,
): Promise<AuthorResult> {
  try {
    const [event] = await nostr.query(
      [{ kinds: [0], authors: [pubkey], limit: 1 }],
      { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) },
    );
    if (event) {
      try {
        const metadata = n.json().pipe(n.metadata()).parse(event.content);
        cacheProfile(pubkey, metadata, event);
        return { metadata, event };
      } catch (err) {
        if (__DEV__) console.warn('[useAuthor] Metadata parse failed for', pubkey.slice(0, 8), err);
        return { event };
      }
    }
  } catch (err) {
    if (__DEV__ && (err as Error)?.name !== 'AbortError') {
      console.warn('[useAuthor] Pool query failed for', pubkey.slice(0, 8), (err as Error)?.message);
    }
  }

  // Fallback: try individual relays (same pattern as web)
  const fallbackSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
  const relaysToTry = FALLBACK_RELAYS.slice(0, 3);

  try {
    const event = await Promise.any(
      relaysToTry.map(async (relayUrl) => {
        const relay = nostr.relay(relayUrl);
        const [ev] = await relay.query(
          [{ kinds: [0], authors: [pubkey], limit: 1 }],
          { signal: fallbackSignal },
        );
        if (!ev) throw new Error('no event');
        return ev;
      }),
    );

    try {
      const metadata = n.json().pipe(n.metadata()).parse(event.content);
      cacheProfile(pubkey, metadata, event);
      return { metadata, event };
    } catch (err) {
      if (__DEV__) console.warn('[useAuthor] Fallback metadata parse failed for', pubkey.slice(0, 8), err);
      return { event };
    }
  } catch (err) {
    if (__DEV__ && (err as Error)?.name !== 'AggregateError') {
      console.warn('[useAuthor] All fallback relays failed for', pubkey.slice(0, 8));
    }
    return {};
  }
}

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  return useQuery<AuthorResult>({
    queryKey: ['author', pubkey ?? ''],
    queryFn: async ({ signal }) => {
      if (!pubkey) return {};

      // Check MMKV disk cache first
      const cached = getCachedProfile(pubkey, CACHE_MAX_AGE);
      if (cached?.metadata) {
        const cacheAge = Date.now() - cached.cachedAt;
        if (cacheAge < STALE_TIME) {
          return {
            metadata: cached.metadata ?? undefined,
            event: cached.event ?? undefined,
          };
        }

        // Background refresh — return stale data now, update when fresh arrives
        const capturedPubkey = pubkey;
        fetchAuthorFromNetwork(capturedPubkey, signal, nostr as NostrPool).then((result) => {
          if (result.metadata) {
            queryClient.setQueryData(['author', capturedPubkey], result);
          }
        }).catch((err) => {
          if (__DEV__ && err?.name !== 'AbortError') console.warn('[useAuthor] Background refresh failed for', capturedPubkey.slice(0, 8), err);
        });

        return {
          metadata: cached.metadata ?? undefined,
          event: cached.event ?? undefined,
        };
      }

      return fetchAuthorFromNetwork(pubkey, signal, nostr as NostrPool);
    },
    staleTime: STALE_TIME,
    gcTime: CACHE_MAX_AGE,
    retry: 1,
    enabled: !!pubkey,
  });
}

/**
 * Batch-prefetch profiles for a set of notes and seed the query cache.
 */
export function useBulkAuthors() {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  async function prefetchFromNotes(notes: NostrEvent[], signal?: AbortSignal) {
    const pubkeys = new Set<string>();
    for (const note of notes) {
      pubkeys.add(note.pubkey);
    }

    // Only fetch pubkeys not already cached (check React Query + MMKV)
    const toFetch = [...pubkeys].filter(pk => {
      if (queryClient.getQueryData(['author', pk])) return false;
      const cached = getCachedProfile(pk, CACHE_MAX_AGE);
      if (cached?.metadata) {
        // Seed React Query from disk cache
        queryClient.setQueryData(['author', pk], {
          metadata: cached.metadata,
          event: cached.event ?? undefined,
        });
        return false;
      }
      return true;
    });
    if (toFetch.length === 0) return;

    try {
      const events = await nostr.query(
        [{ kinds: [0], authors: toFetch.slice(0, 100), limit: toFetch.length }],
        { signal: signal ?? AbortSignal.timeout(8000) },
      );
      for (const event of events) {
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event.content);
          queryClient.setQueryData(['author', event.pubkey], { metadata, event });
          cacheProfile(event.pubkey, metadata, event);
        } catch (err) {
          if (__DEV__) console.warn('[useBulkAuthors] Metadata parse failed for', event.pubkey.slice(0, 8), err);
        }
      }
    } catch (err) {
      if (__DEV__ && (err as Error)?.name !== 'AbortError') {
        console.warn('[useBulkAuthors] Bulk fetch failed:', (err as Error)?.message);
      }
    }
  }

  return { prefetchFromNotes };
}
