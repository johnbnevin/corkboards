import { type NostrEvent, type NostrMetadata, type NostrFilter, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCachedProfile, cacheProfile } from '@/lib/cacheStore';
import { FALLBACK_RELAYS } from '@/components/NostrProvider';
import { getBackupRelaysUsed } from '@/hooks/useNostrBackup';
import { debugWarn } from '@/lib/debug';

interface NostrPool {
  query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  relay: (url: string) => { query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> };
}

interface AuthorResult {
  event?: NostrEvent;
  metadata?: NostrMetadata;
}

const CACHE_MAX_AGE = 48 * 60 * 60 * 1000; // 48 hours
const STALE_TIME = 48 * 60 * 60 * 1000; // 48 hours - profiles rarely change

async function fetchAuthorFromNetwork(
  pubkey: string,
  signal: AbortSignal,
  nostr: NostrPool
): Promise<AuthorResult> {
  try {
    const [event] = await nostr.query(
      [{ kinds: [0], authors: [pubkey], limit: 1 }],
      { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) },
    );

    if (event) {
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
  } catch (err) {
    // Fall through to fallback
    if ((err as Error)?.name !== 'AbortError') {
      debugWarn('[useAuthor] Pool query failed for', pubkey.slice(0, 8), (err as Error)?.message);
    }
  }

  const fallbackSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);

  // Prefer relays not recently used for backup to spread load
  const backupUsed = getBackupRelaysUsed();
  const sortedRelays = [...FALLBACK_RELAYS].sort((a, b) => {
    const aUsed = backupUsed.has(a) ? 1 : 0;
    const bUsed = backupUsed.has(b) ? 1 : 0;
    return aUsed - bUsed;
  });
  // Only try first 3 to avoid opening too many connections
  const relaysToTry = sortedRelays.slice(0, 3);

  try {
    const event = await Promise.any(
      relaysToTry.map(async (relayUrl) => {
        const relay = nostr.relay(relayUrl);
        const [ev] = await relay.query(
          [{ kinds: [0], authors: [pubkey], limit: 1 }],
          { signal: fallbackSignal }
        );
        if (!ev) throw new Error('no event');
        return ev;
      })
    );

    try {
      const metadata = n.json().pipe(n.metadata()).parse(event.content);
      cacheProfile(pubkey, metadata, event).catch((err) => {
        debugWarn('[useAuthor] Fallback cache write failed:', err);
      });
      return { metadata, event };
    } catch (err) {
      debugWarn('[useAuthor] Fallback metadata parse failed for', pubkey.slice(0, 8), err);
      return { event };
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AggregateError') {
      debugWarn('[useAuthor] All fallback relays failed for', pubkey.slice(0, 8));
    }
    return {};
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

      return fetchAuthorFromNetwork(pubkey, signal, nostr as NostrPool);
    },
    staleTime: STALE_TIME,
    gcTime: CACHE_MAX_AGE,
    retry: 1,
  });
}
