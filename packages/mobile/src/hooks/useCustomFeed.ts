/**
 * useCustomFeed — fetch notes for a custom corkboard feed definition.
 * Mobile port of packages/web/src/hooks/useCustomFeed.ts.
 *
 * Differences from web:
 * - Uses mobile NostrProvider instead of @nostrify/react
 * - RSS support is skipped (no web fetch proxy on mobile)
 * - Uses @core/feedConstants and @core/rss for shared constants
 */
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { FEED_KINDS } from '@core/feedConstants';
import { baseTimeWindow } from '@core/rss';
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

// Max authors per relay query to avoid silent truncation by relays
const MAX_AUTHORS_PER_QUERY = 500;

/**
 * Batch-fetch notes from a set of authors, chunking large author lists.
 * Equivalent to web's batchFetchByAuthors but inlined for mobile
 * (no separate feedUtils on mobile yet).
 */
async function batchFetchByAuthors(opts: {
  nostr: { query: (filters: unknown[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> };
  authors: string[];
  limit: number;
  since?: number;
  until?: number;
  multiplier?: number;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<NostrEvent[]> {
  const {
    nostr,
    authors,
    limit,
    since,
    until,
    multiplier = 1,
    onProgress,
  } = opts;

  if (authors.length === 0) return [];

  const kinds = [...FEED_KINDS].filter(k => k !== 5) as number[];
  const baseWindowSeconds = baseTimeWindow(authors.length);
  const now = Math.floor(Date.now() / 1000);
  const effectiveSince = since ?? (now - (baseWindowSeconds * multiplier));

  onProgress?.(0, 1);

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_QUERY) {
      chunks.push(authors.slice(i, i + MAX_AUTHORS_PER_QUERY));
    }

    const allEvents = await Promise.all(
      chunks.map(chunk =>
        nostr.query(
          [{
            kinds,
            authors: chunk,
            limit,
            since: effectiveSince,
            ...(until !== undefined ? { until } : {}),
          }],
          { signal: AbortSignal.timeout(15_000) },
        ).catch((err) => {
          console.warn('[batchFetch] Chunk query failed:', err);
          return [] as NostrEvent[];
        })
      )
    );

    const events = allEvents.flat();
    onProgress?.(1, 1);

    // Deduplicate and sort
    const seen = new Set<string>();
    const deduped = events.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    return deduped.sort((a, b) => b.created_at - a.created_at);
  } catch (err) {
    console.warn('[batchFetch] Query failed:', err);
    onProgress?.(1, 1);
    return [];
  }
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
        // RSS skipped on mobile
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
            const kinds = [...FEED_KINDS] as number[];
            const relayFilter =
              feed.pubkeys.length > 0
                ? { kinds, authors: feed.pubkeys, limit }
                : { kinds, limit };

            // Query each custom relay individually
            const relayResults = await Promise.allSettled(
              feed.relays.map(url =>
                (nostr as any).relay?.(url)?.query?.([relayFilter], {
                  signal: AbortSignal.timeout(8000),
                }) ?? Promise.resolve([])
              )
            );

            for (const result of relayResults) {
              if (result.status === 'fulfilled') {
                for (const e of result.value as NostrEvent[]) {
                  if (!seen.has(e.id)) {
                    seen.add(e.id);
                    nostrEvents.push(e);
                    if (nostrEvents.length >= limit) break;
                  }
                }
              }
              if (nostrEvents.length >= limit) break;
            }
          } catch {
            // Relay queries failed
          }
        }

        // RSS skipped on mobile — no web fetch proxy available

        return nostrEvents.sort((a, b) => b.created_at - a.created_at);
      },
      enabled: enabled && !!feed,
    }),
  };
}

export { batchFetchByAuthors };
