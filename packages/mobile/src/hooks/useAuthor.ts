/**
 * useAuthor — profile fetch with MMKV disk cache, background refresh,
 * and fallback relay logic. Mirrors web's useAuthor.ts.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NSchema as n } from '@nostrify/nostrify';
import type { NostrEvent, NostrFilter, NostrMetadata } from '@nostrify/nostrify';
import { useNostr, FALLBACK_RELAYS } from '../lib/NostrProvider';
import { PROFILE_INDEXER_RELAYS } from '@core/relayConstants';
import { fetchProfilesBulk, type ProfilePool } from '@core/profileBulkFetch';
import { getCachedProfile, cacheProfile } from '../lib/cacheStore';
import { PROFILE_TTL_MS } from '@core/cacheConfig';

// Cap simultaneous profile network fetches to avoid overwhelming relays/device.
const MAX_CONCURRENT_AUTHOR_FETCHES = 6;
let _activeFetches = 0;
const _fetchQueue: Array<() => void> = [];

function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (_activeFetches < MAX_CONCURRENT_AUTHOR_FETCHES) {
    _activeFetches++;
    return fn().finally(() => {
      _activeFetches--;
      _fetchQueue.shift()?.();
    });
  }
  return new Promise<T>((resolve, reject) => {
    _fetchQueue.push(() => {
      _activeFetches++;
      fn().then(resolve, reject).finally(() => {
        _activeFetches--;
        _fetchQueue.shift()?.();
      });
    });
  });
}

interface AuthorResult {
  event?: NostrEvent;
  metadata?: NostrMetadata;
}

interface NostrPool {
  query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  relay: (url: string) => { query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> };
}

// Single source of truth shared with web — was a drifted 24h copy.
const CACHE_MAX_AGE = PROFILE_TTL_MS;
const STALE_TIME = PROFILE_TTL_MS;

async function fetchAuthorFromNetwork(
  pubkey: string,
  signal: AbortSignal,
  nostr: NostrPool,
): Promise<AuthorResult> {
  const netSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);

  const firstEvent = (evs: NostrEvent[]): NostrEvent => {
    const e = evs[0];
    if (!e) throw new Error('no event');
    return e;
  };

  // Race the pool + profile indexers + a couple of fallbacks IN PARALLEL, taking
  // the first valid kind-0 — resolves far more reliably than pool-then-fallback
  // (keeps profiles from getting stuck as "user_xxxx"). Parity with web.
  const attempts: Promise<NostrEvent>[] = [
    nostr.query([{ kinds: [0], authors: [pubkey], limit: 1 }], { signal: netSignal }).then(firstEvent),
    ...[...PROFILE_INDEXER_RELAYS, ...FALLBACK_RELAYS.slice(0, 2)].map((relayUrl) =>
      nostr.relay(relayUrl)
        .query([{ kinds: [0], authors: [pubkey], limit: 1 }], { signal: netSignal })
        .then(firstEvent),
    ),
  ];

  // Throw on total failure (instead of returning {}) so React Query's retry
  // policy actually fires — returning {} caches "no profile" as a success and
  // leaves the note showing user_xxxx until something remounts the query.
  const event: NostrEvent = await Promise.any(attempts);

  try {
    const metadata = n.json().pipe(n.metadata()).parse(event.content);
    cacheProfile(pubkey, metadata, event);
    return { metadata, event };
  } catch (err) {
    if (__DEV__) console.warn('[useAuthor] Metadata parse failed for', pubkey.slice(0, 8), err);
    return { event };
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

      return withConcurrencyLimit(() => fetchAuthorFromNetwork(pubkey, signal, nostr as NostrPool));
    },
    // Unresolved profiles (no metadata) go stale in 2 min so they re-check instead
    // of sticking as "user_xxxx" for the whole TTL — was 30s, raised to cut the
    // per-card refetch/re-render churn on long sessions. Parity with web.
    staleTime: (query) => (query.state.data?.metadata ? STALE_TIME : 120_000),
    gcTime: CACHE_MAX_AGE,
    // Startup is congested (relay connects + feed queries + N profile fetches);
    // spaced retries resolve most of the "shows npub/user_xxxx" cases.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    enabled: !!pubkey,
  });
}

// Pubkeys currently being fetched by ANY prefetch call. Concurrent calls skip
// these instead of dropping the whole call (which would silently leave every
// author of a newly-loaded page unprefetched whenever a previous batch was in
// flight). Parity with web's useBulkAuthors.
const inFlightPubkeys = new Set<string>();

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

    // Only fetch pubkeys not already cached (check React Query + MMKV). Skip
    // pubkeys another prefetch call is already fetching, but still process the
    // rest — dropping the whole call would leave new pages unresolved.
    const toFetch = [...pubkeys].filter(pk => {
      if (inFlightPubkeys.has(pk)) return false;
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
    for (const pk of toFetch) inFlightPubkeys.add(pk);

    try {
      // Pool + profile indexers per batch, indexer retry pass for stragglers
      // (@core/profileBulkFetch, shared with web). The old version queried the
      // pool only AND silently truncated to the first 100 pubkeys — everything
      // else trickled through the 6-concurrent per-card path.
      const events = await fetchProfilesBulk(nostr as unknown as ProfilePool, toFetch, { signal });
      for (const event of events.values()) {
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
    } finally {
      for (const pk of toFetch) inFlightPubkeys.delete(pk);
    }
  }

  return { prefetchFromNotes };
}
