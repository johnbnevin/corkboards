/**
 * Mobile feed utilities: batch author fetching and deduplication.
 *
 * Ported from packages/web/src/lib/feedUtils.ts.
 * Skips RSS-related functions (not used on mobile).
 */
import type { NostrEvent } from '@nostrify/nostrify';
import type { useNostr } from './NostrProvider';
import { FEED_KINDS } from '@core/feedConstants';
import { baseTimeWindow } from '@core/rss';

// Re-export core constants for convenience
export { FEED_PAGE_SIZE_MOBILE, FEED_LOAD_MORE_COUNT, AUTHOR_BATCH_SIZE, MAX_PARALLEL_BATCHES, FEED_KINDS } from '@core/feedConstants';

// Max authors per relay query to avoid silent truncation by relays
const MAX_AUTHORS_PER_QUERY = 500;

// ─── Batch author fetch ─────────────────────────────────────────────────────

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
  const baseWindowSeconds = baseTimeWindow(authors.length);

  const now = Math.floor(Date.now() / 1000);

  // If since is provided (load more), use that directly
  // Otherwise calculate from multiplier (initial load)
  const effectiveSince = since ?? (now - (baseWindowSeconds * multiplier));

  if (__DEV__) {
    const effectiveWindowMinutes = (baseWindowSeconds * multiplier) / 60;
    console.log(`[batchFetch] Query for ${authors.length} authors, window: ${effectiveWindowMinutes}min (${multiplier}x)`);
  }

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
          console.warn('[batchFetch] Chunk query failed:', err);
          return [] as NostrEvent[];
        })
      )
    );

    const events = allEvents.flat();
    onProgress?.(1, 1);
    if (__DEV__) console.log(`[batchFetch] Got ${events.length} events from ${authors.length} authors (${chunks.length} chunks)`);

    // Deduplicate and sort
    return deduplicateAndSort(events);
  } catch (err) {
    console.warn('[batchFetch] Query failed:', err);
    onProgress?.(1, 1);
    return [];
  }
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Deduplicate events by ID and sort by created_at descending.
 */
export function deduplicateAndSort(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const deduped = events.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return deduped.sort((a, b) => b.created_at - a.created_at);
}

/**
 * Merge new events into an existing array, deduplicating by ID.
 * Returns the merged, sorted array.
 */
export function mergeEvents(existing: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const existingIds = new Set(existing.map(e => e.id));
  const trulyNew = incoming.filter(e => !existingIds.has(e.id));
  if (trulyNew.length === 0) return existing;
  return [...existing, ...trulyNew].sort((a, b) => b.created_at - a.created_at);
}
