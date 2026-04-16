/**
 * useRelayFeed — Fetches recent notes from a single Nostr relay URL.
 *
 * Port of packages/web/src/hooks/useRelayFeed.ts for mobile.
 */
import { useQuery } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { createRelay } from '../lib/NostrProvider';

interface UseRelayFeedOptions {
  relayUrl: string;
  enabled?: boolean;
  limit: number;
}

export function useRelayFeed({ relayUrl, enabled = true, limit }: UseRelayFeedOptions) {
  return useQuery<NostrEvent[]>({
    queryKey: ['relay-notes', relayUrl, limit],
    queryFn: async () => {
      const events: NostrEvent[] = [];
      try {
        const relay = createRelay(relayUrl, { backoff: false });
        const timeout = setTimeout(() => relay.close(), 10_000);

        try {
          for await (const msg of relay.req([{ kinds: [1, 30023], limit }])) {
            if (msg[0] === 'EVENT') {
              events.push(msg[2] as NostrEvent);
            } else if (msg[0] === 'EOSE') {
              break;
            }
          }
        } finally {
          clearTimeout(timeout);
          relay.close();
        }
      } catch (err) {
        console.error('[relay] Failed to fetch from', relayUrl, err);
      }

      return events.sort((a, b) => b.created_at - a.created_at);
    },
    enabled: enabled && !!relayUrl,
  });
}
