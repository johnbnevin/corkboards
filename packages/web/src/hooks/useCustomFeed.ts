import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import {
  batchFetchByAuthors,
  fetchRssFeed,
  rssItemsToEvents,
  rssItemId,
  FEED_KINDS,
} from '@/lib/feedUtils';
import type { NostrEvent } from '@nostrify/nostrify';

export interface CustomFeedDef {
  id: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
}

export interface UseCustomFeedOptions {
  feed: CustomFeedDef | null;
  enabled?: boolean;
  limit: number;
  onProgress?: (loaded: number, total: number) => void;
  onBatchStart?: (total: number) => void;
  onBatchEnd?: () => void;
}

export function useCustomFeed({
  feed,
  enabled = true,
  limit,
  onProgress,
  onBatchStart,
  onBatchEnd,
}: UseCustomFeedOptions) {
  const { nostr } = useNostr();

  return {
    data: useQuery<NostrEvent[]>({
      queryKey: [
        'custom-feed-notes',
        feed?.id,
        feed?.pubkeys,
        feed?.relays,
        feed?.rssUrls,
        limit,
      ],
      queryFn: async () => {
        if (!feed) return [];

        let nostrEvents: NostrEvent[] = [];

        if (feed.pubkeys.length > 0) {
          onBatchStart?.(1);
          nostrEvents = await batchFetchByAuthors({
            nostr,
            authors: feed.pubkeys,
            limit,
            onProgress,
          });
          onBatchEnd?.();
        }

        // Also try custom relays if configured and we need more notes
        if (feed.relays.length > 0 && nostrEvents.length < limit) {
          try {
            const seen = new Set(nostrEvents.map(e => e.id));
            const relayGroup = nostr.group(feed.relays);
            const relayFilter =
              feed.pubkeys.length > 0
                ? { kinds: [...FEED_KINDS], authors: feed.pubkeys, limit }
                : { kinds: [...FEED_KINDS], limit };
            const relayEvents = await relayGroup.query([relayFilter], {
              signal: AbortSignal.timeout(8000),
            });
            for (const e of relayEvents) {
              if (!seen.has(e.id)) {
                seen.add(e.id);
                nostrEvents.push(e);
                if (nostrEvents.length >= limit) break;
              }
            }
          } catch {
            // Relay group failed
          }
        }

        const rssEvents: NostrEvent[] = [];
        if (feed.rssUrls && feed.rssUrls.length > 0) {
          const feedCount = feed.rssUrls.length;
          const stillNeed = Math.max(0, limit - nostrEvents.length);
          const perFeedLimit = stillNeed > 0 ? Math.max(3, Math.floor(stillNeed / feedCount)) : 0;

          const rssSeen = new Set(nostrEvents.map((e) => e.id));
          for (const feedUrl of feed.rssUrls) {
            try {
              const rssFeed = await fetchRssFeed(feedUrl, perFeedLimit);
              if (!rssFeed) continue;
              for (let i = 0; i < rssFeed.items.length; i++) {
                const item = rssFeed.items[i];
                const id = rssItemId(item.link || item.title, feedUrl);
                if (!rssSeen.has(id)) {
                  rssSeen.add(id);
                  rssEvents.push(
                    ...rssItemsToEvents([item], rssFeed.title, rssFeed.icon, feedUrl)
                  );
                }
              }
            } catch (err) {
              console.warn(
                '[customFeed] RSS failed for',
                feedUrl,
                err instanceof Error ? err.message : err
              );
            }
          }
        }

        const allEvents = [...nostrEvents, ...rssEvents];
        return allEvents.sort((a, b) => b.created_at - a.created_at);
      },
      enabled: enabled && !!feed,
    }),
  };
}
