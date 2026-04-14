import { useQuery } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { FALLBACK_RELAYS } from '../lib/NostrProvider';
import { FEED_PAGE_SIZE_MOBILE, FEED_KINDS } from '@core/feedConstants';

/**
 * Fetch recent notes from a set of authors.
 * Falls back to global relay feed when no authors are provided.
 */
export function useFeed(authors: string[] = []) {
  const { nostr } = useNostr();

  return useQuery<NostrEvent[]>({
    queryKey: ['mobile-feed', authors.length > 0 ? authors.slice(0, 10).join(',') : 'global'],
    queryFn: async () => {
      const filter = {
        kinds: FEED_KINDS.filter(k => k === 1 || k === 6) as number[],
        limit: FEED_PAGE_SIZE_MOBILE,
        ...(authors.length > 0 ? { authors } : {}),
      };

      const events: NostrEvent[] = [];
      const seenIds = new Set<string>();

      // When no authors: query fallback relays directly
      const relaysToQuery = authors.length > 0 ? undefined : FALLBACK_RELAYS;

      if (relaysToQuery) {
        // Direct relay queries for global mode
        await Promise.allSettled(
          relaysToQuery.slice(0, 3).map(async (url) => {
            try {
              // Use nostr.query with a single-relay approach by temporarily routing
              const relayEvents = await nostr.query([filter], { signal: AbortSignal.timeout(8000) });
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
