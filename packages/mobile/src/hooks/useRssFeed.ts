/**
 * useRssFeed
 *
 * Fetches and parses a single RSS/Atom feed URL via the corkboards.me proxy,
 * returning items as pseudo-NostrEvents for unified rendering.
 *
 * Mobile port of packages/web/src/hooks/useRssFeed.ts.
 * Uses React Native's built-in fetch (same API, no changes needed).
 */
import { useQuery } from '@tanstack/react-query';
import { fetchRssFeed, rssItemsToEvents } from '../lib/feedUtils';
import type { NostrEvent } from '@nostrify/nostrify';

interface UseRssFeedOptions {
  feedUrl: string | null;
  enabled?: boolean;
  maxItems?: number;
}

export function useRssFeed({ feedUrl, enabled: _enabled = true, maxItems = 20 }: UseRssFeedOptions) {
  return useQuery<NostrEvent[]>({
    queryKey: ['rss-notes', feedUrl],
    queryFn: async () => {
      if (!feedUrl) return [];
      try {
        const feed = await fetchRssFeed(feedUrl, maxItems);
        if (!feed) return [];
        return rssItemsToEvents(feed.items, feed.title, feed.icon, feedUrl);
      } catch (error) {
        if (__DEV__) console.warn('[rss] Failed to fetch', feedUrl, error instanceof Error ? error.message : error);
        return [];
      }
    },
    enabled: false, // Don't auto-fetch, will be triggered via refetch()
    staleTime: Infinity, // Never refetch automatically
  });
}
