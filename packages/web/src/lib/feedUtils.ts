/**
 * Shared feed utilities: batch author fetching and RSS helpers.
 *
 * Pure constants and RSS helpers are in @core. This file adds the
 * platform-specific fetch functions that depend on @nostrify/react and Vite.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import type { useNostr } from '@nostrify/react';
import { debugLog, debugWarn, debugError } from '@/lib/debug';

// Re-export core constants and helpers
import { FEED_KINDS as _FEED_KINDS, RSS_PROXY } from '@core/feedConstants';
export { FEED_PAGE_SIZE_DESKTOP, FEED_PAGE_SIZE_MOBILE, FEED_LOAD_MORE_COUNT, AUTHOR_BATCH_SIZE, MAX_PARALLEL_BATCHES, RSS_PROXY, FEED_KINDS } from '@core/feedConstants';
const FEED_KINDS = _FEED_KINDS;
import { baseTimeWindow as _baseTimeWindow } from '@core/rss';
export { rssItemId, rssItemsToEvents, baseTimeWindow } from '@core/rss';
export type { RssFeedResult } from '@core/rss';

// ─── RSS fetch (platform-specific: uses fetch + import.meta.env) ────────────

export async function fetchRssFeed(feedUrl: string, maxItems = 20): Promise<import('@core/rss').RssFeedResult | null> {
  let feedDomain = '';
  try { feedDomain = new URL(feedUrl).hostname.replace('www.', ''); } catch { /* ignore */ }
  const feedIcon = `https://icons.duckduckgo.com/ip3/${feedDomain}.ico`;

  try {
    const url = `${RSS_PROXY}?url=${encodeURIComponent(feedUrl)}&max=${maxItems}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    debugLog('[rss] Proxy response for', feedUrl, '→ status:', response.status, 'content-type:', response.headers.get('content-type'));
    const text = await response.text();
    debugLog('[rss] Raw response for', feedUrl, '→', text.slice(0, 500));
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { debugError('[rss] Non-JSON response for', feedUrl); return null; }
    if (response.ok) {
      if (!data.error && (data.items as unknown[])?.length > 0) {
        debugLog('[rss] Loaded', (data.items as unknown[]).length, 'items from', feedUrl);
        return { title: (data.title as string) || feedDomain, icon: (data.icon as string) || feedIcon, items: data.items as import('@core/rss').RssFeedResult['items'] };
      }
      if (data.error) debugWarn('[rss] Error for', feedUrl, data.error);
    }
  } catch (err) {
    debugWarn('[rss] Failed for', feedUrl, err instanceof Error ? err.message : err);
  }

  return null;
}

// ─── Batch author fetch (platform-specific: uses @nostrify/react) ───────────

export interface BatchFetchOpts {
  nostr: ReturnType<typeof useNostr>['nostr'];
  authors: string[];
  kinds?: number[];
  /** Note limit per fetch. */
  limit: number;
  /** Per-fetch timeout ms (default 15000). */
  timeout?: number;
  /** Oldest timestamp for pagination (load older). */
  until?: number;
  /** Newest timestamp for pagination (load newer or initial load). */
  since?: number;
  /** Time window multiplier for initial load (1x, 2x, 3x). */
  multiplier?: number;
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Fetch notes from all authors in a SINGLE relay query (up to 500 authors).
 *
 * Base time windows:
 * - 0-500 authors: 1 hour (3600s)
 * - 501-1000 authors: 30 minutes (1800s)
 * - 1000+ authors: 10 minutes (600s)
 *
 * Multiplier (1x/2x/3x) multiplies the base window for initial load.
 * "Load more" clicks extend the window additively (not multiplicative).
 */
// Max authors per relay query to avoid silent truncation by relays
const MAX_AUTHORS_PER_QUERY = 500;

export async function batchFetchByAuthors(opts: BatchFetchOpts): Promise<NostrEvent[]> {
  const {
    nostr,
    authors,
    kinds = [...FEED_KINDS].filter(k => k !== 5),
    limit,
    timeout = 15_000,
    until,
    since,
    multiplier = 1,
    onProgress,
  } = opts;

  if (authors.length === 0) return [];

  // Calculate base time window based on author count
  const baseWindowSeconds = _baseTimeWindow(authors.length);

  const now = Math.floor(Date.now() / 1000);

  // If since is provided (load more), use that directly
  // Otherwise calculate from multiplier (initial load)
  const effectiveSince = since ?? (now - (baseWindowSeconds * multiplier));
  const effectiveWindowMinutes = (baseWindowSeconds * multiplier) / 60;

  debugLog(`[batchFetch] Query for ${authors.length} authors, window: ${effectiveWindowMinutes}min (${multiplier}x)`);

  onProgress?.(0, 1);

  try {
    // Chunk authors to avoid relay-side truncation (some relays cap at 100-500)
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
          { signal: AbortSignal.timeout(timeout) },
        ).catch((err) => {
          debugWarn('[batchFetch] Chunk query failed:', err);
          return [] as NostrEvent[];
        })
      )
    );

    const events = allEvents.flat();
    onProgress?.(1, 1);
    debugLog(`[batchFetch] Got ${events.length} events from ${authors.length} authors (${chunks.length} chunks)`);

    // Deduplicate and sort
    const seen = new Set<string>();
    const deduped = events.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    return deduped.sort((a, b) => b.created_at - a.created_at);
  } catch (err) {
    debugWarn('[batchFetch] Query failed:', err);
    onProgress?.(1, 1);
    return [];
  }
}

// ─── Hashtag fetch ───────────────────────────────────────────────────────────

export interface HashtagFetchOpts {
  nostr: ReturnType<typeof useNostr>['nostr'];
  hashtags: string[];
  kinds?: number[];
  limit: number;
  timeout?: number;
  since?: number;
  until?: number;
}

/**
 * Fetch notes matching one or more hashtags (#t tags).
 * Returns deduped, sorted by created_at descending.
 */
export async function fetchByHashtags(opts: HashtagFetchOpts): Promise<NostrEvent[]> {
  const {
    nostr,
    hashtags,
    kinds = [...FEED_KINDS].filter(k => k !== 5),
    limit,
    timeout = 15_000,
    since,
    until,
  } = opts;

  if (hashtags.length === 0) return [];

  // Normalize hashtags: lowercase, no leading #
  const tags = hashtags.map(t => t.replace(/^#/, '').toLowerCase());

  try {
    const events = await nostr.query(
      [{
        kinds,
        '#t': tags,
        limit,
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      }],
      { signal: AbortSignal.timeout(timeout) },
    );

    const seen = new Set<string>();
    return events
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => b.created_at - a.created_at);
  } catch (err) {
    debugWarn('[hashtagFetch] Query failed:', err);
    return [];
  }
}
