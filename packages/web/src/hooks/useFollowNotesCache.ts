/**
 * useFollowNotesCache
 *
 * Centralized cache for notes from all follows + self.
 * Fetches once on load, then provides filtered views for each tab type.
 * Exposes loadOlder/loadNewer for explicit pagination.
 * 
 * Persistent: Cache survives page refresh via IndexedDB.
 * Local-first: Shows cached data immediately, syncs in background.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { batchFetchByAuthors } from '@/lib/feedUtils';
import { debugLog } from '@/lib/debug';
import {
  getNotesFromMemory,
  saveNotesToCache,
  mergeNotesToCache,
  setCacheMetadata,
  isCacheLoaded,
} from '@/lib/notesCache';
import type { NostrEvent } from '@nostrify/nostrify';
import { useMemo, useCallback, useEffect, useRef } from 'react';

export interface UseFollowNotesCacheOptions {
  contacts: string[];
  selfPubkey?: string;
  enabled?: boolean;
  limit: number;
  multiplier?: number; // 1x, 2x, 3x for initial time window
  includeSelf?: boolean; // Whether to include self's notes in the cache
  onProgress?: (loaded: number, total: number) => void;
}

export function useFollowNotesCache({ contacts, selfPubkey, enabled = true, limit, multiplier = 1, includeSelf = true, onProgress }: UseFollowNotesCacheOptions) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const hasInitialized = useRef(false);

  const allAuthors = useMemo(() => {
    const authors = [...contacts];
    if (includeSelf && selfPubkey && !authors.includes(selfPubkey)) {
      authors.push(selfPubkey);
    }
    return authors;
  }, [contacts, selfPubkey, includeSelf]);

  // Calculate base window in seconds (1 hour for 0-500 authors)
  const baseWindowSeconds = useMemo(() => {
    if (allAuthors.length <= 500) return 3600;
    if (allAuthors.length <= 1000) return 1800;
    return 600;
  }, [allAuthors.length]);

  // Key changes only when going from 0→N contacts (initial load) — NOT on every +1 follow,
  // which would cause a full feed refetch and scroll reset.
  const hasAuthors = allAuthors.length > 0;
  const queryKey = useMemo(() => ['follow-notes-cache', hasAuthors] as const, [hasAuthors]);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async () => {
      const authorCount = allAuthors.length;
      debugLog('[notesCache] queryFn called, authors:', authorCount);

      if (authorCount === 0) {
        debugLog('[notesCache] No authors, returning empty');
        return [];
      }
      
      // Get existing data to check if we need to refetch
      const existingData = queryClient.getQueryData(queryKey) as NostrEvent[] | undefined;
      
      // If we already have events and author count hasn't changed significantly, skip
      if (existingData && existingData.length > 0) {
        debugLog('[notesCache] Using existing', existingData.length, 'events');
        return existingData;
      }
      
      // Use fixed time window multiplied by the multiplier
      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;
      
      debugLog('[notesCache] Fetching notes:');
      debugLog('  baseWindowSeconds:', baseWindowSeconds, 'seconds');
      debugLog('  multiplier:', multiplier);
      debugLog('  timeWindowSeconds:', timeWindowSeconds, 'seconds =', timeWindowSeconds / 3600, 'hours');
      debugLog('  now:', now, '(', new Date(now * 1000).toISOString(), ')');
      debugLog('  since:', since, '(', new Date(since * 1000).toISOString(), ')');
      debugLog('  fetching from', new Date(since * 1000).toLocaleString(), 'to', new Date(now * 1000).toLocaleString());
      
      const events = await batchFetchByAuthors({
        nostr,
        authors: allAuthors,
        limit,
        since,
        multiplier,
        onProgress: onProgress ?? (() => {}),
      });
      
      debugLog('[notesCache] Got', events.length, 'events');
      if (events.length > 0) {
        const oldest = events.reduce((min, e) => e.created_at < min ? e.created_at : min, events[0].created_at);
        const newest = events.reduce((max, e) => e.created_at > max ? e.created_at : max, events[0].created_at);
        const timeSpan = (newest - oldest) / 3600;
        debugLog('[notesCache] Time span:', timeSpan.toFixed(2), 'hours');
        debugLog('[notesCache] Oldest:', new Date(oldest * 1000).toISOString());
        debugLog('[notesCache] Newest:', new Date(newest * 1000).toISOString());
      }
      
      // Merge fresh relay data with persisted IDB cache so notes accumulated
      // from previous load-more/load-newer clicks survive page reload.
      // Only include cached notes from authors we're following (not from other feeds).
      const authorSet = new Set(allAuthors);
      const cached = getNotesFromMemory();
      const seenIds = new Set(events.map(e => e.id));
      const cachedExtras = cached.filter(e => !seenIds.has(e.id) && authorSet.has(e.pubkey));
      const merged = cachedExtras.length > 0
        ? [...events, ...cachedExtras].sort((a, b) => b.created_at - a.created_at)
        : events;

      // Save to cache
      await saveNotesToCache(merged);
      await setCacheMetadata({ lastSync: Date.now(), authorCount: allAuthors.length });

      return merged;
    },
    enabled: enabled && allAuthors.length > 0,
    retry: 0, // No retry on failure - user can manually load more
    staleTime: 5 * 60 * 1000, // 5 min — marks data stale but won't auto-refetch (refetchOnWindowFocus is off)
    gcTime: 30 * 60 * 1000, // 30 min — keep in memory well past stale so navigation doesn't trigger refetch
    refetchOnReconnect: false, // Don't refetch on reconnect
  });

  // Initialize from cache on first load (shows cached data immediately while fetching)
  // Filter by allAuthors to prevent notes from other feeds (custom corkboards, friend tabs)
  // leaking into the follow cache. Without this filter, the me tab could show notes from
  // non-followed authors that accumulated in IDB across tab switches.
  useEffect(() => {
    if (!hasInitialized.current && isCacheLoaded()) {
      const cached = getNotesFromMemory();
      if (cached.length > 0) {
        const authorSet = new Set(allAuthors);
        const filtered = authorSet.size > 0 ? cached.filter(e => authorSet.has(e.pubkey)) : cached;
        debugLog('[notesCache] Initializing with', filtered.length, 'cached notes (', cached.length, 'total in IDB)');
        queryClient.setQueryData(queryKey, filtered);
      }
      hasInitialized.current = true;
    }
  }, [queryClient, queryKey, limit, allAuthors]);

  // Track how far back we've loaded (in seconds) for load older
  const loadMoreOffsetRef = useRef(0);

  const loadOlder = useCallback(async () => {
    // Increment offset - additive, each click adds another base window
    loadMoreOffsetRef.current += baseWindowSeconds;
    const maxOffset = baseWindowSeconds * 3; // Max 3x
    const offset = Math.min(loadMoreOffsetRef.current, maxOffset);
    
    debugLog('[notesCache] Load more clicked, offset:', offset / 3600, 'hours');
    
    // Get oldest timestamp in current cache
    const cached = query.data ?? [];
    if (cached.length === 0) return;
    
    const oldestTimestamp = cached.reduce((min, e) => e.created_at < min ? e.created_at : min, cached[0].created_at);
    
    // Fetch notes older than our current oldest, up to offset seconds back
    const until = oldestTimestamp;
    const since = oldestTimestamp - offset;
    
    debugLog('[notesCache] Fetching older notes: until', until, 'since', since);
    
    const events = await batchFetchByAuthors({
      nostr,
      authors: allAuthors,
      limit,
      until,
      since,
      onProgress: onProgress ?? (() => {}),
    });

    if (events.length > 0) {
      await mergeNotesToCache(events);
      debugLog('[notesCache] Added', events.length, 'older notes');
      
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map(e => e.id));
        const newEvents = events.filter(e => !seen.has(e.id));
        return [...existing, ...newEvents].sort((a, b) => b.created_at - a.created_at);
      });
    }

    return events.length;
  }, [query.data, queryClient, queryKey, nostr, allAuthors, limit, baseWindowSeconds, onProgress]);

  const loadNewer = useCallback(async () => {
    const cached = query.data ?? [];
    if (cached.length === 0) return;

    const newestTimestamp = cached.reduce((max, e) => e.created_at > max ? e.created_at : max, cached[0].created_at);
    const events = await batchFetchByAuthors({
      nostr,
      authors: allAuthors,
      limit,
      since: newestTimestamp + 1,
      onProgress: onProgress ?? (() => {}),
    });

    if (events.length > 0) {
      const added = await mergeNotesToCache(events);
      if (added > 0) {
        debugLog('[notesCache] Added', added, 'newer notes to cache');
        await setCacheMetadata({ lastSync: Date.now() });
      }
      
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map(e => e.id));
        const newEvents = events.filter(e => !seen.has(e.id));
        return [...newEvents, ...existing].sort((a, b) => b.created_at - a.created_at);
      });
    }

    return events.length;
  }, [query.data, nostr, allAuthors, limit, onProgress, queryClient, queryKey]);

  const getFilteredByPubkeys = useCallback((pubkeys: string[]) => {
    const cached = query.data ?? [];
    const pubkeySet = new Set(pubkeys);
    return cached.filter(e => pubkeySet.has(e.pubkey));
  }, [query.data]);

  return {
    ...query,
    loadOlder,
    loadNewer,
    getFilteredByPubkeys,
    cacheSize: query.data?.length ?? 0,
  };
}
