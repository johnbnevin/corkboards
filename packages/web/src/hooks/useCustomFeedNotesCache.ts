/**
 * useCustomFeedNotesCache
 * 
 * Separate cache for custom feed (corkboard) notes to prevent
 * interference with other tabs' pagination and caches.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { batchFetchByAuthors } from '@/lib/feedUtils';
import { debugLog } from '@/lib/debug';
import type { NostrEvent } from '@nostrify/nostrify';
import { useMemo, useCallback, useEffect, useRef, useState } from 'react';

export interface CustomFeedDef {
  id: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
}

export interface UseCustomFeedNotesCacheOptions {
  feedId: string;
  pubkeys: string[];
  enabled?: boolean;
  limit: number;
  multiplier?: number; // 1x, 2x, 3x for initial time window
  onProgress?: (loaded: number, total: number) => void;
  /** Outbox pass: discover the authors' NIP-65 relays before fetching notes. */
  ensureRelays?: (pubkeys: string[]) => Promise<unknown>;
}

export function useCustomFeedNotesCache({
  feedId,
  pubkeys,
  enabled = true,
  limit,
  multiplier = 1,
  onProgress,
  ensureRelays,
}: UseCustomFeedNotesCacheOptions) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  /**
   * Feed ids already hydrated from the persisted cache — a SET, not a boolean.
   *
   * This hook is mounted once for the life of the app and `feedId` changes as
   * the user switches corkboards. With a single `hasInitialized` flag, only the
   * FIRST corkboard visited ever got its persisted notes back; every other board
   * depended on React Query still holding data (10 min gcTime) or on a fresh
   * network fetch landing. When neither did — coming back to a board after a
   * while, or on a cold cache — the board showed the "No notes found" empty
   * state despite having notes on disk, and a second attempt "fixed" it because
   * by then the fetch had completed.
   */
  const hydratedFeedIds = useRef<Set<string>>(new Set());

  // Base look-back window. Small corkboards (few authors) look back FAR further:
  // a handful of people may post only a few times a day, so a 1-hour window
  // misses their recent notes entirely (the "npub notes don't show" bug). Larger
  // feeds use a tighter window since many authors make it dense.
  const baseWindowSeconds = useMemo(() => {
    if (pubkeys.length <= 25) return 3600 * 24 * 3; // ≤25 authors → 3 days
    if (pubkeys.length <= 100) return 3600 * 12;    // ≤100 → 12h
    if (pubkeys.length <= 500) return 3600;         // 1h
    if (pubkeys.length <= 1000) return 1800;
    return 600;
  }, [pubkeys.length]);

  // Include feedId and pubkeys.length in key for proper cache isolation
  const queryKey = useMemo(() => ['custom-feed-cache', feedId, pubkeys.length] as const, [feedId, pubkeys.length]);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async ({ queryKey }) => {
      const [, , pubkeyCount] = queryKey;
      debugLog(`[customFeedCache] queryFn called for feed ${feedId}, authors: ${pubkeyCount}`);
      
      if (pubkeys.length === 0) {
        debugLog(`[customFeedCache] No authors for feed ${feedId}, returning empty`);
        return [];
      }
      
      // Get existing data to check if we need to refetch
      const existingData = queryClient.getQueryData(queryKey) as NostrEvent[] | undefined;
      
      // If we already have events and pubkey count hasn't changed, skip
      if (existingData && existingData.length > 0) {
        debugLog(`[customFeedCache] Using existing ${existingData.length} events for feed ${feedId}`);
        return existingData;
      }
      
      // Use fixed time window multiplied by the multiplier
      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;
      
      debugLog(`[customFeedCache] Fetching notes for feed ${feedId}:`);
      debugLog(`  baseWindowSeconds: ${baseWindowSeconds} seconds`);
      debugLog(`  multiplier: ${multiplier}`);
      debugLog(`  timeWindowSeconds: ${timeWindowSeconds} seconds = ${timeWindowSeconds / 3600} hours`);
      debugLog(`  now: ${now} (${new Date(now * 1000).toISOString()})`);
      debugLog(`  since: ${since} (${new Date(since * 1000).toISOString()})`);
      debugLog(`  fetching from ${new Date(since * 1000).toLocaleString()} to ${new Date(now * 1000).toLocaleString()}`);
      
      // Outbox pass: make sure we know these authors' own write relays before
      // fetching, so the pool routes to them (an npub you don't follow otherwise
      // has no discoverable outbox and their notes get missed entirely).
      if (ensureRelays) {
        try { await ensureRelays(pubkeys); } catch { /* best-effort */ }
      }

      let events = await batchFetchByAuthors({
        nostr,
        authors: pubkeys,
        limit,
        since,
        multiplier,
        onProgress: onProgress ?? (() => {}),
      });

      // Nothing in the window? These authors just post rarely — anchor to their
      // most recent note and fetch around it, so a corkboard never shows empty
      // for people who haven't posted in the last window. (Parity with mobile.)
      if (events.length === 0) {
        debugLog(`[customFeedCache] No events in window for ${feedId}; anchoring to most recent`);
        const recent = await nostr.query(
          [{ authors: pubkeys, limit: 1 }],
          { signal: AbortSignal.timeout(8000) },
        ).catch(() => [] as NostrEvent[]);
        if (recent.length > 0) {
          const anchor = recent[0].created_at;
          const older = await batchFetchByAuthors({
            nostr, authors: pubkeys, limit,
            since: anchor - timeWindowSeconds, until: anchor + 1,
            onProgress: onProgress ?? (() => {}),
          });
          events = older.length > 0 ? older : recent;
        }
      }

      debugLog(`[customFeedCache] Got ${events.length} events for feed ${feedId}`);
      if (events.length > 0) {
        const oldest = events.reduce((min, e) => e.created_at < min ? e.created_at : min, events[0].created_at);
        const newest = events.reduce((max, e) => e.created_at > max ? e.created_at : max, events[0].created_at);
        const timeSpan = (newest - oldest) / 3600;
        debugLog(`[customFeedCache] Time span: ${timeSpan.toFixed(2)} hours`);
        debugLog(`[customFeedCache] Oldest: ${new Date(oldest * 1000).toISOString()}`);
        debugLog(`[customFeedCache] Newest: ${new Date(newest * 1000).toISOString()}`);
      }
      
      // A fetch that returned nothing (even after the anchor rescue) must not
      // touch the persisted board: after idle it usually means dead sockets,
      // not an empty board. Serve what's on disk.
      if (events.length === 0) {
        return await getCustomFeedNotes(feedId);
      }

      // MERGE with the persisted cache rather than overwrite. saveCustomFeedNotes
      // here replaced the blob with whatever this one fetch returned — so a
      // partial post-idle fetch (only the relays that reconnected first)
      // destroyed the board's accumulated notes both on screen and on disk.
      await mergeCustomFeedNotes(feedId, events);
      await setCustomFeedMetadata(feedId, { lastSync: Date.now(), pubkeyCount: pubkeys.length });

      return await getCustomFeedNotes(feedId);
    },
    enabled: enabled && pubkeys.length > 0,
    retry: 0, // No retry on failure
    staleTime: 5 * 60 * 1000, // 5 min — marks data stale but won't auto-refetch (refetchOnWindowFocus is off)
    refetchOnReconnect: false,
  });

  // Hydrate this feed from the persisted cache — once per feed, not once per
  // mount. Runs on every feedId/queryKey change, so switching boards shows the
  // notes already on disk immediately instead of an empty state until the
  // network answers.
  useEffect(() => {
    if (!feedId || hydratedFeedIds.current.has(feedId)) return;
    if (!isCustomFeedCacheLoaded()) return;
    // Don't clobber a live result with an older persisted one.
    const existing = queryClient.getQueryData<NostrEvent[]>(queryKey);
    if (existing && existing.length > 0) {
      hydratedFeedIds.current.add(feedId);
      return;
    }
    const cached = getCustomFeedNotesFromMemory(feedId);
    if (cached.length > 0) {
      debugLog(`[customFeedCache] Hydrating feed ${feedId} with ${cached.length} cached notes`);
      queryClient.setQueryData(queryKey, cached);
    }
    hydratedFeedIds.current.add(feedId);
  }, [queryClient, queryKey, feedId]);

  // Load older notes for this custom feed
  const loadOlder = useCallback(async () => {
    const cached = query.data ?? [];
    if (cached.length === 0) return;
    
    const oldestTimestamp = cached.reduce((min, e) => e.created_at < min ? e.created_at : min, cached[0].created_at);
    const until = oldestTimestamp - 1;

    // Adaptive look-back: start at the base window just below our current oldest
    // note and widen exponentially only when a window comes back empty. This
    // returns the MOST-RECENT older notes (days/weeks back) rather than leaping
    // straight to years-old history — which is what a bare `since:0` query does,
    // because it sweeps backward until it collects `limit` notes and, for sparse
    // authors, that spans years. Widening still crosses genuine gaps (unlike the
    // old fixed window, which got stuck returning nothing across a gap).
    let windowSeconds = baseWindowSeconds;
    let events: NostrEvent[] = [];
    for (let i = 0; i < 8; i++) {
      const since = Math.max(0, until - windowSeconds);
      debugLog(`[customFeedCache] Loading older notes for feed ${feedId}: until ${until}, window ${windowSeconds}s (attempt ${i + 1})`);
      events = await batchFetchByAuthors({
        nostr,
        authors: pubkeys,
        limit,
        until,
        since,
        onProgress: onProgress ?? (() => {}),
      });
      if (events.length > 0) break;
      if (since === 0) break; // reached the beginning of time — nothing older exists
      windowSeconds *= 4;
    }

    if (events.length > 0) {
      await mergeCustomFeedNotes(feedId, events);
      debugLog(`[customFeedCache] Added ${events.length} older notes to feed ${feedId}`);
      
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map(e => e.id));
        const newEvents = events.filter(e => !seen.has(e.id));
        return [...existing, ...newEvents].sort((a, b) => b.created_at - a.created_at);
      });
    }

    return events.length;
  }, [query.data, queryClient, queryKey, nostr, pubkeys, limit, feedId, onProgress, baseWindowSeconds]);

  // Load newer notes for this custom feed
  const loadNewer = useCallback(async () => {
    const cached = query.data ?? [];
    if (cached.length === 0) return;

    const newestTimestamp = cached.reduce((max, e) => e.created_at > max ? e.created_at : max, cached[0].created_at);
    const events = await batchFetchByAuthors({
      nostr,
      authors: pubkeys,
      limit,
      since: newestTimestamp + 1,
      onProgress: onProgress ?? (() => {}),
    });

    if (events.length > 0) {
      const added = await mergeCustomFeedNotes(feedId, events);
      if (added > 0) {
        debugLog(`[customFeedCache] Added ${added} newer notes to feed ${feedId}`);
        await setCustomFeedMetadata(feedId, { lastSync: Date.now(), pubkeyCount: pubkeys.length });
      }
      
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map(e => e.id));
        const newEvents = events.filter(e => !seen.has(e.id));
        return [...newEvents, ...existing].sort((a, b) => b.created_at - a.created_at);
      });
    }

    return events.length;
  }, [query.data, nostr, pubkeys, limit, onProgress, queryClient, queryKey, feedId]);

  // Get notes filtered by pubkeys (for immediate access)
  const getFilteredByPubkeys = useCallback((filterPubkeys: string[]) => {
    const cached = query.data ?? [];
    const pubkeySet = new Set(filterPubkeys);
    return cached.filter(e => pubkeySet.has(e.pubkey));
  }, [query.data]);

  // Track if there are more notes to load
  const [hasMore, setHasMore] = useState(true);

  // Update hasMore when we get data
  useEffect(() => {
    if (query.data) {
      // If we got fewer notes than requested, assume no more
      if (query.data.length < limit) {
        setHasMore(false);
      } else {
        setHasMore(true);
      }
    }
  }, [query.data, limit]);

  return {
    ...query,
    loadOlder,
    loadNewer,
    getFilteredByPubkeys,
    cacheSize: query.data?.length ?? 0,
    hasMore,
  };
}

// ============================================================================
// Custom Feed Cache Storage (separate from global notes cache)
// ============================================================================

import { idbGet, idbSet, idbRemove, idbKeys } from '@/lib/idb';
import { withKeyedLock } from '@core/keyedMutex';

const CUSTOM_FEED_CACHE_PREFIX = 'custom-feed-cache:';
const CUSTOM_FEED_METADATA_PREFIX = 'custom-feed-metadata:';
const MAX_NOTES_PER_FEED = 1000;

function getCustomFeedCacheKey(feedId: string): string {
  return `${CUSTOM_FEED_CACHE_PREFIX}${feedId}`;
}

function getCustomFeedMetadataKey(feedId: string): string {
  return `${CUSTOM_FEED_METADATA_PREFIX}${feedId}`;
}

interface CustomFeedMetadata {
  lastSync: number;
  pubkeyCount: number;
}

// In-memory cache for custom feeds
const customFeedMemCache = new Map<string, NostrEvent[]>();
let customFeedCacheLoaded = false;

export async function saveCustomFeedNotes(feedId: string, events: NostrEvent[]): Promise<void> {
  // Serialize with mergeCustomFeedNotes/prune on the same feed so a concurrent
  // read-modify-write can't overwrite this blob (or vice-versa) and drop notes. (C3)
  return withKeyedLock(`custom-feed:${feedId}`, async () => {
    const key = getCustomFeedCacheKey(feedId);
    // Prune to most recent notes if over limit
    const pruned = events.length > MAX_NOTES_PER_FEED
      ? events.sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES_PER_FEED)
      : events;
    await idbSet(key, JSON.stringify(pruned));
    customFeedMemCache.set(feedId, pruned);
  });
}

export async function mergeCustomFeedNotes(feedId: string, events: NostrEvent[]): Promise<number> {
  return withKeyedLock(`custom-feed:${feedId}`, async () => {
    const key = getCustomFeedCacheKey(feedId);
    const existing = await getCustomFeedNotes(feedId);
    const existingIds = new Set(existing.map(e => e.id));

    const newEvents = events.filter(e => !existingIds.has(e.id));
    if (newEvents.length > 0) {
      let merged = [...existing, ...newEvents].sort((a, b) => b.created_at - a.created_at);
      // Prune to limit
      if (merged.length > MAX_NOTES_PER_FEED) {
        merged = merged.slice(0, MAX_NOTES_PER_FEED);
      }
      await idbSet(key, JSON.stringify(merged));
      customFeedMemCache.set(feedId, merged);
    }

    return newEvents.length;
  });
}

export async function getCustomFeedNotes(feedId: string): Promise<NostrEvent[]> {
  // Check in-memory cache first
  if (customFeedMemCache.has(feedId)) {
    return customFeedMemCache.get(feedId) ?? [];
  }
  
  // Load from IndexedDB
  const key = getCustomFeedCacheKey(feedId);
  const stored = await idbGet(key);
  
  if (!stored) {
    return [];
  }

  try {
    const events: NostrEvent[] = JSON.parse(stored);
    customFeedMemCache.set(feedId, events);
    return events;
  } catch {
    // Invalid stored data, remove it
    await idbRemove(key);
    return [];
  }
}

export function getCustomFeedNotesFromMemory(feedId: string): NostrEvent[] {
  return customFeedMemCache.get(feedId) ?? [];
}

export async function setCustomFeedMetadata(feedId: string, metadata: CustomFeedMetadata): Promise<void> {
  const key = getCustomFeedMetadataKey(feedId);
  await idbSet(key, JSON.stringify(metadata));
}

export async function getCustomFeedMetadata(feedId: string): Promise<CustomFeedMetadata | null> {
  const key = getCustomFeedMetadataKey(feedId);
  const stored = await idbGet(key);
  
  if (!stored) {
    return null;
  }

  try {
    return JSON.parse(stored);
  } catch {
    await idbRemove(key);
    return null;
  }
}

export async function clearCustomFeedCache(feedId: string): Promise<void> {
  const cacheKey = getCustomFeedCacheKey(feedId);
  const metadataKey = getCustomFeedMetadataKey(feedId);
  
  await idbRemove(cacheKey);
  await idbRemove(metadataKey);
  customFeedMemCache.delete(feedId);
}

export async function getAllCustomFeedIds(): Promise<string[]> {
  const keys = await idbKeys();
  return keys
    .filter(key => key.startsWith(CUSTOM_FEED_CACHE_PREFIX))
    .map(key => key.substring(CUSTOM_FEED_CACHE_PREFIX.length));
}

export function isCustomFeedCacheLoaded(): boolean {
  return customFeedCacheLoaded;
}

// Mark cache system as ready — feeds are loaded lazily when their tab opens
customFeedCacheLoaded = true;

// One-time cleanup: prune oversized feed caches left over from before limits were added
(async () => {
  try {
    const feedIds = await getAllCustomFeedIds();
    for (const feedId of feedIds) {
      // Take the per-feed lock so this prune can't race a live save/merge. (C3/M6)
      await withKeyedLock(`custom-feed:${feedId}`, async () => {
        const key = getCustomFeedCacheKey(feedId);
        const stored = await idbGet(key);
        if (!stored) return;
        const events: NostrEvent[] = JSON.parse(stored);
        if (events.length > MAX_NOTES_PER_FEED) {
          const pruned = events.sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES_PER_FEED);
          await idbSet(key, JSON.stringify(pruned));
          debugLog(`[customFeedCache] Pruned feed ${feedId}: ${events.length} → ${pruned.length}`);
        }
      });
    }
  } catch {
    // Best-effort cleanup
  }
})();