/**
 * useFollowNotesCache — Centralized cache for notes from all follows + self.
 *
 * Ported from packages/web/src/hooks/useFollowNotesCache.ts.
 * Uses MMKV for persistence instead of IndexedDB.
 * Local-first: shows cached data immediately, syncs in background.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { batchFetchByAuthors, deduplicateAndSort } from '../lib/feedUtils';
import { mobileStorage } from '../storage/MmkvStorage';
import type { NostrEvent } from '@nostrify/nostrify';
import { useMemo, useCallback, useEffect, useRef } from 'react';

// ─── MMKV-backed notes cache ───────────────────────────────────────────────

const NOTES_CACHE_KEY = 'follow-notes-cache:events';
const NOTES_META_KEY = 'follow-notes-cache:meta';

interface CacheMetadata {
  lastSync: number;
  authorCount?: number;
}

/** Read cached notes from MMKV (synchronous). */
function getNotesFromCache(): NostrEvent[] {
  try {
    const stored = mobileStorage.getSync(NOTES_CACHE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as NostrEvent[];
  } catch {
    return [];
  }
}

/** Save notes to MMKV cache. */
function saveNotesToCache(events: NostrEvent[]): void {
  try {
    // Limit stored notes to prevent MMKV from growing too large on mobile
    const MAX_CACHED_NOTES = 2000;
    const toStore = events.length > MAX_CACHED_NOTES
      ? events.slice(0, MAX_CACHED_NOTES)
      : events;
    mobileStorage.setSync(NOTES_CACHE_KEY, JSON.stringify(toStore));
  } catch (err) {
    console.warn('[notesCache] Failed to save to MMKV:', err);
  }
}

/** Merge new notes into MMKV cache. Returns count of truly new notes added. */
function mergeNotesToCache(incoming: NostrEvent[]): number {
  const existing = getNotesFromCache();
  const existingIds = new Set(existing.map(e => e.id));
  const trulyNew = incoming.filter(e => !existingIds.has(e.id));
  if (trulyNew.length === 0) return 0;
  const merged = [...existing, ...trulyNew].sort((a, b) => b.created_at - a.created_at);
  saveNotesToCache(merged);
  return trulyNew.length;
}

function setCacheMetadata(meta: Partial<CacheMetadata>): void {
  try {
    const existing = getCacheMetadata();
    const updated = { ...existing, ...meta };
    mobileStorage.setSync(NOTES_META_KEY, JSON.stringify(updated));
  } catch {
    // non-critical
  }
}

function getCacheMetadata(): CacheMetadata {
  try {
    const stored = mobileStorage.getSync(NOTES_META_KEY);
    if (!stored) return { lastSync: 0 };
    return JSON.parse(stored) as CacheMetadata;
  } catch {
    return { lastSync: 0 };
  }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseFollowNotesCacheOptions {
  contacts: string[];
  selfPubkey?: string;
  enabled?: boolean;
  limit: number;
  multiplier?: number; // 1x, 2x, 3x for initial time window
  includeSelf?: boolean; // Whether to include self's notes in the cache
  onProgress?: (loaded: number, total: number) => void;
}

export function useFollowNotesCache({
  contacts,
  selfPubkey,
  enabled = true,
  limit,
  multiplier = 1,
  includeSelf = true,
  onProgress,
}: UseFollowNotesCacheOptions) {
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

  // Key changes only when going from 0->N contacts (initial load) -- NOT on every +1 follow
  const hasAuthors = allAuthors.length > 0;
  const queryKey = useMemo(() => ['follow-notes-cache', hasAuthors] as const, [hasAuthors]);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async () => {
      const authorCount = allAuthors.length;
      if (__DEV__) console.log('[notesCache] queryFn called, authors:', authorCount);

      if (authorCount === 0) {
        if (__DEV__) console.log('[notesCache] No authors, returning empty');
        return [];
      }

      // Get existing data to check if we need to refetch
      const existingData = queryClient.getQueryData(queryKey) as NostrEvent[] | undefined;

      // If we already have events and author count hasn't changed significantly, skip
      if (existingData && existingData.length > 0) {
        if (__DEV__) console.log('[notesCache] Using existing', existingData.length, 'events');
        return existingData;
      }

      // Use fixed time window multiplied by the multiplier
      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;

      if (__DEV__) {
        console.log('[notesCache] Fetching notes:');
        console.log('  baseWindowSeconds:', baseWindowSeconds, 'seconds');
        console.log('  multiplier:', multiplier);
        console.log('  timeWindowSeconds:', timeWindowSeconds, 'seconds =', timeWindowSeconds / 3600, 'hours');
      }

      const events = await batchFetchByAuthors({
        nostr,
        authors: allAuthors,
        limit,
        since,
        multiplier,
        onProgress: onProgress ?? (() => {}),
      });

      if (__DEV__) {
        console.log('[notesCache] Got', events.length, 'events');
        if (events.length > 0) {
          const oldest = events.reduce((min, e) => e.created_at < min ? e.created_at : min, events[0].created_at);
          const newest = events.reduce((max, e) => e.created_at > max ? e.created_at : max, events[0].created_at);
          const timeSpan = (newest - oldest) / 3600;
          console.log('[notesCache] Time span:', timeSpan.toFixed(2), 'hours');
        }
      }

      // Merge fresh relay data with persisted MMKV cache so notes accumulated
      // from previous load-more/load-newer survive app restart.
      // Only include cached notes from authors we're following.
      const authorSet = new Set(allAuthors);
      const cached = getNotesFromCache();
      const seenIds = new Set(events.map(e => e.id));
      const cachedExtras = cached.filter(e => !seenIds.has(e.id) && authorSet.has(e.pubkey));
      const merged = cachedExtras.length > 0
        ? [...events, ...cachedExtras].sort((a, b) => b.created_at - a.created_at)
        : events;

      // Save to MMKV cache
      saveNotesToCache(merged);
      setCacheMetadata({ lastSync: Date.now(), authorCount: allAuthors.length });

      return merged;
    },
    enabled: enabled && allAuthors.length > 0,
    retry: 0, // No retry on failure - user can manually load more
    staleTime: 5 * 60 * 1000, // 5 min
    gcTime: 30 * 60 * 1000, // 30 min
    refetchOnReconnect: false,
  });

  // Initialize from MMKV cache on first load (shows cached data immediately while fetching)
  // Filter by allAuthors to prevent notes from other feeds leaking in.
  useEffect(() => {
    if (!hasInitialized.current) {
      const cached = getNotesFromCache();
      if (cached.length > 0) {
        const authorSet = new Set(allAuthors);
        const filtered = authorSet.size > 0 ? cached.filter(e => authorSet.has(e.pubkey)) : cached;
        if (__DEV__) console.log('[notesCache] Initializing with', filtered.length, 'cached notes (', cached.length, 'total in MMKV)');
        queryClient.setQueryData(queryKey, filtered);
      }
      hasInitialized.current = true;
    }
  }, [queryClient, queryKey, allAuthors]);

  // Track how far back we've loaded (in seconds) for load older
  const loadMoreOffsetRef = useRef(0);

  const loadOlder = useCallback(async () => {
    // Increment offset - additive, each call adds another base window
    loadMoreOffsetRef.current += baseWindowSeconds;
    const maxOffset = baseWindowSeconds * 3; // Max 3x
    const offset = Math.min(loadMoreOffsetRef.current, maxOffset);

    if (__DEV__) console.log('[notesCache] Load older, offset:', offset / 3600, 'hours');

    // Get oldest timestamp in current cache
    const cached = query.data ?? [];
    if (cached.length === 0) return;

    const oldestTimestamp = cached.reduce((min, e) => e.created_at < min ? e.created_at : min, cached[0].created_at);

    // Fetch notes older than our current oldest, up to offset seconds back
    const until = oldestTimestamp;
    const since = oldestTimestamp - offset;

    if (__DEV__) console.log('[notesCache] Fetching older notes: until', until, 'since', since);

    const events = await batchFetchByAuthors({
      nostr,
      authors: allAuthors,
      limit,
      until,
      since,
      onProgress: onProgress ?? (() => {}),
    });

    if (events.length > 0) {
      mergeNotesToCache(events);
      if (__DEV__) console.log('[notesCache] Added', events.length, 'older notes');

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
      const added = mergeNotesToCache(events);
      if (added > 0) {
        if (__DEV__) console.log('[notesCache] Added', added, 'newer notes to cache');
        setCacheMetadata({ lastSync: Date.now() });
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
