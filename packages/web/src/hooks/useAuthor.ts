import { type NostrEvent, type NostrMetadata, type NostrFilter, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCachedProfile, cacheProfile } from '@/lib/cacheStore';
import { FALLBACK_RELAYS } from '@/components/NostrProvider';
import { PROFILE_INDEXER_RELAYS } from '@core/relayConstants';
import { getBackupRelaysUsed } from '@/hooks/useNostrBackup';
import { debugWarn } from '@/lib/debug';
import { PROFILE_TTL_MS } from '@core/cacheConfig';

// Cap simultaneous profile network fetches to avoid opening too many WebSocket
// connections at once (WebKit crashes above ~50 concurrent WS connections).
// With up to 3 relays per profile query, 6 concurrent fetches = max 18 connections.
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

interface NostrPool {
  query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  relay: (url: string) => { query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> };
}

interface AuthorResult {
  event?: NostrEvent;
  metadata?: NostrMetadata;
}

// Single source of truth shared with mobile (profiles rarely change).
const CACHE_MAX_AGE = PROFILE_TTL_MS;
const STALE_TIME = PROFILE_TTL_MS;

async function fetchAuthorFromNetwork(
  pubkey: string,
  signal: AbortSignal,
  nostr: NostrPool
): Promise<AuthorResult> {
  const netSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);

  // Prefer fallback relays not recently used for backup, to spread load.
  const backupUsed = getBackupRelaysUsed();
  const fallbacks = [...FALLBACK_RELAYS]
    .sort((a, b) => (backupUsed.has(a) ? 1 : 0) - (backupUsed.has(b) ? 1 : 0))
    .slice(0, 2);

  const firstEvent = (evs: NostrEvent[]): NostrEvent => {
    const e = evs[0];
    if (!e) throw new Error('no event');
    return e;
  };

  // Race the pool + profile indexers + a couple of fallbacks IN PARALLEL, taking
  // the first valid kind-0. The indexers (purplepag.es, relay.nostr.band) hold
  // profiles for ~everyone, so a parallel race resolves far more reliably than
  // querying the pool first and only falling back on failure — the "some users
  // still show as user_xxxx" case.
  const attempts: Promise<NostrEvent>[] = [
    nostr.query([{ kinds: [0], authors: [pubkey], limit: 1 }], { signal: netSignal }).then(firstEvent),
    ...[...PROFILE_INDEXER_RELAYS, ...fallbacks].map((relayUrl) =>
      nostr.relay(relayUrl)
        .query([{ kinds: [0], authors: [pubkey], limit: 1 }], { signal: netSignal })
        .then(firstEvent),
    ),
  ];

  let event: NostrEvent;
  try {
    event = await Promise.any(attempts);
  } catch {
    return {};
  }

  try {
    const metadata = n.json().pipe(n.metadata()).parse(event.content);
    cacheProfile(pubkey, metadata, event).catch((err) => {
      debugWarn('[useAuthor] Cache write failed:', err);
    });
    return { metadata, event };
  } catch (err) {
    debugWarn('[useAuthor] Metadata parse failed for', pubkey.slice(0, 8), err);
    return { event };
  }
}

export function useAuthor(pubkey: string | undefined, enabled = true) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  return useQuery<AuthorResult>({
    queryKey: ['author', pubkey ?? ''],
    enabled: !!pubkey && enabled,
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {};
      }

      const cached = await getCachedProfile(pubkey, CACHE_MAX_AGE);

      if (cached?.metadata) {
        const cacheAge = Date.now() - cached.cachedAt;
        if (cacheAge < STALE_TIME) {
          return {
            metadata: cached.metadata ?? undefined,
            event: cached.event ?? undefined,
          };
        }

        // Background refresh — update query data when fresh profile arrives.
        // Capture pubkey so the async callback updates the correct entry even if the
        // query reruns for a different pubkey before this resolves.
        const capturedPubkey = pubkey;
        fetchAuthorFromNetwork(capturedPubkey, signal, nostr as NostrPool).then((result) => {
          // Bail if this query was cancelled (account switch / logout / unmount)
          // while the refresh was in flight — don't write a now-stale entry into
          // a cache that may belong to a different session.
          if (signal.aborted) return;
          if (result.metadata) {
            queryClient.setQueryData(['author', capturedPubkey], result);
          }
        }).catch((err) => {
          if (err?.name !== 'AbortError') debugWarn('[useAuthor] Background refresh failed for', capturedPubkey.slice(0, 8), err);
        });

        return {
          metadata: cached.metadata ?? undefined,
          event: cached.event ?? undefined,
        };
      }

      return withConcurrencyLimit(() => fetchAuthorFromNetwork(pubkey, signal, nostr as NostrPool));
    },
    // Resolved profiles cache for the full TTL; a still-unresolved one (no
    // metadata) goes stale in 30s so it re-checks on the next access instead of
    // being stuck as "user_xxxx" for the whole TTL.
    staleTime: (query) => (query.state.data?.metadata ? STALE_TIME : 30_000),
    gcTime: CACHE_MAX_AGE,
    retry: 2,
  });
}
