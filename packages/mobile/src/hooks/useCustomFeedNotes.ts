/**
 * useCustomFeedNotes — notes for a custom corkboard with caching and filtering.
 * Mobile port of packages/web/src/hooks/useCustomFeedNotes.ts.
 *
 * Two-tier architecture:
 *  - MMKV is the persistent store (replaces web's IndexedDB)
 *  - React Query holds the current in-memory view
 *
 * On mount: seeds React Query from MMKV cache (instant, no relay).
 * Background: fetches fresh notes from relays and merges into both stores.
 * loadMore: fetches older notes, merges into both stores.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { batchFetchByAuthors } from './useCustomFeed';
import {
  saveCustomFeedNotes,
  mergeCustomFeedNotes,
  getCustomFeedNotesFromMemory,
  isCustomFeedCacheLoaded,
} from './useCustomFeedNotesCache';
import { FEED_KINDS } from '@core/feedConstants';
import { fetchRssFeed, rssItemsToEvents, rssItemId } from '../lib/feedUtils';
import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';

export interface CustomFeedDef {
  id: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
}

export interface UseCustomFeedNotesOptions {
  feed: CustomFeedDef | null;
  isActive: boolean;
  limit: number;
  multiplier: number;
  onProgress?: (loaded: number, total: number) => void;
  /** Outbox pass: discover the authors' NIP-65 relays before fetching notes. */
  ensureRelays?: (pubkeys: string[]) => Promise<unknown>;
}

export interface UseCustomFeedNotesResult {
  notes: NostrEvent[];
  isLoading: boolean;
  isLookingFurther: boolean;
  hasMore: boolean;
  loadMore: (hours: number) => Promise<number>;
  addNotes: (events: NostrEvent[]) => void;
  refresh: () => void;
  hoursLoaded: number;
}

export function useCustomFeedNotes({
  feed,
  isActive,
  limit,
  multiplier,
  onProgress,
  ensureRelays,
}: UseCustomFeedNotesOptions): UseCustomFeedNotesResult {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const hoursLoadedRef = useRef(0);
  const hasSeededRef = useRef(false);

  // Small corkboards look back far further (sparse posters); larger feeds stay
  // tight. Keep in sync with web useCustomFeedNotesCache.
  const baseWindowSeconds = (() => {
    const n = feed?.pubkeys.length ?? 0;
    if (n <= 25) return 3600 * 24 * 3; // ≤25 authors → 3 days
    if (n <= 100) return 3600 * 12;    // ≤100 → 12h
    return 3600;                        // 1h
  })();

  // Stable query key: feed id + pubkeys join (pubkeys changing = new feed)
  const queryKey = useMemo(
    () => ['custom-feed-notes', feed?.id ?? '', feed?.pubkeys?.join(',') ?? ''] as const,
    [feed?.id, feed?.pubkeys],
  );

  // Seed React Query from MMKV cache instantly on first render
  useEffect(() => {
    if (!feed || feed.pubkeys.length === 0) return;
    if (hasSeededRef.current) return;
    if (!isCustomFeedCacheLoaded()) return;

    const pubkeySet = new Set(feed.pubkeys);
    const cached = getCustomFeedNotesFromMemory(feed.id).filter(e => pubkeySet.has(e.pubkey));
    if (cached.length > 0) {
      if (__DEV__) console.log('[customFeedNotes] Seeding', cached.length, 'notes from MMKV for', feed.id);
      queryClient.setQueryData(queryKey, cached);
    }
    hasSeededRef.current = true;
  // Only run once per feed, after cache is loaded
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed?.id, feed?.pubkeys?.join(',')]);

  // Reset seed flag when feed changes
  useEffect(() => {
    hasSeededRef.current = false;
    hoursLoadedRef.current = 0;
  }, [feed?.id]);

  // Background fetch from relay — merges into MMKV + React Query
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!feed || feed.pubkeys.length === 0) return [];

      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;

      if (__DEV__) console.log('[customFeedNotes] Fetching from relay, window:', timeWindowSeconds / 3600, 'hr');

      // Outbox pass: discover the authors' own write relays before fetching.
      if (ensureRelays) {
        try { await ensureRelays(feed.pubkeys); } catch { /* best-effort */ }
      }

      const events = await batchFetchByAuthors({
        nostr,
        authors: feed.pubkeys,
        limit,
        since,
        onProgress: onProgress ?? (() => {}),
      });

      if (__DEV__) console.log('[customFeedNotes] Got', events.length, 'events from relay');

      // If nothing in time window, find most recent note and fetch around it
      if (events.length === 0) {
        if (__DEV__) console.log('[customFeedNotes] No events in window, searching for most recent');
        const kinds = [...FEED_KINDS] as number[];
        const recent = await nostr.query([{
          kinds,
          authors: feed.pubkeys,
          limit: 1,
        }], { signal: AbortSignal.timeout(10000) });

        if (recent.length > 0) {
          const anchor = recent[0].created_at;
          const olderEvents = await batchFetchByAuthors({
            nostr,
            authors: feed.pubkeys,
            limit,
            since: anchor - timeWindowSeconds,
            until: anchor,
            onProgress: onProgress ?? (() => {}),
          });
          const result = olderEvents.length > 0 ? olderEvents : recent;
          await saveCustomFeedNotes(feed.id, result);
          hoursLoadedRef.current = multiplier;
          return result;
        }
        return [];
      }

      // Merge fresh events into MMKV cache
      await mergeCustomFeedNotes(feed.id, events);
      hoursLoadedRef.current = multiplier;

      // Fetch RSS feeds and merge
      const rssEvents: NostrEvent[] = [];
      if (feed.rssUrls && feed.rssUrls.length > 0) {
        const rssSeen = new Set(events.map(e => e.id));
        for (const feedUrl of feed.rssUrls) {
          try {
            const rssFeed = await fetchRssFeed(feedUrl, 20);
            if (!rssFeed) continue;
            for (const item of rssFeed.items) {
              const id = rssItemId(item.link || item.title, feedUrl);
              if (!rssSeen.has(id)) {
                rssSeen.add(id);
                rssEvents.push(...rssItemsToEvents([item], rssFeed.title, rssFeed.icon, feedUrl));
              }
            }
          } catch (err) {
            if (__DEV__) console.warn('[customFeedNotes] RSS failed for', feedUrl, err instanceof Error ? err.message : err);
          }
        }
      }

      // Merge with any existing cached data already in React Query
      const existing = (queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = [...events, ...rssEvents].filter(e => !existingIds.has(e.id));
      return [...existing, ...fresh].sort((a, b) => b.created_at - a.created_at);
    },
    enabled: isActive && !!feed && feed.pubkeys.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // loadMore — fetches older notes, saves to MMKV + React Query
  const loadMore = useCallback(async (hours: number): Promise<number> => {
    if (!feed || feed.pubkeys.length === 0) return 0;

    hoursLoadedRef.current += hours;

    const current = (queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [];
    if (current.length === 0) return 0;

    const oldestTimestamp = current.reduce((min, e) => e.created_at < min ? e.created_at : min, current[0].created_at);
    const until = oldestTimestamp - 1;

    // Adaptive look-back (parity with web loadOlder): start at the requested step
    // just below our current oldest note and widen exponentially only when a
    // window comes back empty. Returns the MOST-RECENT older notes (days/weeks
    // back) instead of leaping to years-old history — which a bare `since:0`
    // query does, because it sweeps back until it collects `limit` notes and for
    // sparse authors that spans years. Widening still crosses genuine gaps.
    let windowSeconds = Math.max(hours * 3600, 3600);
    let events: NostrEvent[] = [];
    for (let i = 0; i < 8; i++) {
      const since = Math.max(0, until - windowSeconds);
      if (__DEV__) console.log('[customFeedNotes] loadMore until:', new Date(until * 1000).toISOString(), 'window', windowSeconds, 's attempt', i + 1);
      events = await batchFetchByAuthors({
        nostr,
        authors: feed.pubkeys,
        limit,
        since,
        until,
        onProgress: onProgress ?? (() => {}),
      });
      if (events.length > 0) break;
      if (since === 0) break; // reached the beginning of time — nothing older exists
      windowSeconds *= 4;
    }

    if (__DEV__) console.log('[customFeedNotes] loadMore got', events.length, 'events');

    if (events.length > 0) {
      await mergeCustomFeedNotes(feed.id, events);
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const existing = prev ?? [];
        const existingIds = new Set(existing.map(e => e.id));
        const freshEvents = events.filter(e => !existingIds.has(e.id));
        return [...existing, ...freshEvents].sort((a, b) => b.created_at - a.created_at);
      });
    }

    return events.length;
  }, [feed, queryKey, queryClient, nostr, limit, onProgress]);

  // addNotes — external merge (e.g. from loadMoreByCount)
  const addNotes = useCallback((newEvents: NostrEvent[]) => {
    if (newEvents.length === 0 || !feed) return;
    mergeCustomFeedNotes(feed.id, newEvents).catch(err =>
      console.warn('[customFeedNotes] mergeCustomFeedNotes error:', err)
    );
    queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
      const existing = prev ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = newEvents.filter(e => !existingIds.has(e.id));
      if (fresh.length === 0) return existing;
      return [...existing, ...fresh].sort((a, b) => b.created_at - a.created_at);
    });
  }, [feed, queryKey, queryClient]);

  // refresh — re-run the relay query
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const notes = (query.data ?? []) as NostrEvent[];

  return {
    notes,
    isLoading: query.isLoading && notes.length === 0,
    isLookingFurther: false,
    hasMore: true,
    loadMore,
    addNotes,
    refresh,
    // Same per-tab Map pattern as useFeedPagination — reading the ref at return
    // time is deliberate, see useFeedPagination's design comment.
    // eslint-disable-next-line react-hooks/refs
    hoursLoaded: hoursLoadedRef.current,
  };
}
