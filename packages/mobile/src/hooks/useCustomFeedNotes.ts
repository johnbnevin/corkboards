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
}: UseCustomFeedNotesOptions): UseCustomFeedNotesResult {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const hoursLoadedRef = useRef(0);
  const hasSeededRef = useRef(false);

  const baseWindowSeconds = 3600; // 1 hour base

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

      // Merge with any existing cached data already in React Query
      const existing = (queryClient.getQueryData(queryKey) as NostrEvent[] | undefined) ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = events.filter(e => !existingIds.has(e.id));
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
    const since = until - hours * 3600;

    if (__DEV__) console.log('[customFeedNotes] loadMore', hours, 'hr, since:', new Date(since * 1000).toISOString());

    const events = await batchFetchByAuthors({
      nostr,
      authors: feed.pubkeys,
      limit,
      since,
      until,
      onProgress: onProgress ?? (() => {}),
    });

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
    hoursLoaded: hoursLoadedRef.current,
  };
}
