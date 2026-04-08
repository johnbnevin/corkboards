/**
 * useCustomFeedNotesCache
 * 
 * Separate cache for custom feed (corkboard) notes to prevent
 * interference with other tabs' pagination and caches.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { batchFetchByAuthors } from '@/lib/feedUtils';
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
}

export function useCustomFeedNotesCache({ 
  feedId, 
  pubkeys, 
  enabled = true, 
  limit, 
  multiplier = 1, 
  onProgress 
}: UseCustomFeedNotesCacheOptions) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const hasInitialized = useRef(false);

  // Calculate base window in seconds (1 hour for 0-500 authors)
  const baseWindowSeconds = useMemo(() => {
    if (pubkeys.length <= 500) return 3600;
    if (pubkeys.length <= 1000) return 1800;
    return 600;
  }, [pubkeys.length]);

  // Include feedId and pubkeys.length in key for proper cache isolation
  const queryKey = useMemo(() => ['custom-feed-cache', feedId, pubkeys.length] as const, [feedId, pubkeys.length]);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async ({ queryKey }) => {
      const [, , pubkeyCount] = queryKey;
      if (import.meta.env.DEV) console.log(`[customFeedCache] queryFn called for feed ${feedId}, authors: ${pubkeyCount}`);
      
      if (pubkeys.length === 0) {
        if (import.meta.env.DEV) console.log(`[customFeedCache] No authors for feed ${feedId}, returning empty`);
        return [];
      }
      
      // Get existing data to check if we need to refetch
      const existingData = queryClient.getQueryData(queryKey) as NostrEvent[] | undefined;
      
      // If we already have events and pubkey count hasn't changed, skip
      if (existingData && existingData.length > 0) {
        if (import.meta.env.DEV) console.log(`[customFeedCache] Using existing ${existingData.length} events for feed ${feedId}`);
        return existingData;
      }
      
      // Use fixed time window multiplied by the multiplier
      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;
      
      if (import.meta.env.DEV) {
        console.log(`[customFeedCache] Fetching notes for feed ${feedId}:`);
        console.log(`  baseWindowSeconds: ${baseWindowSeconds} seconds`);
        console.log(`  multiplier: ${multiplier}`);
        console.log(`  timeWindowSeconds: ${timeWindowSeconds} seconds = ${timeWindowSeconds / 3600} hours`);
        console.log(`  now: ${now} (${new Date(now * 1000).toISOString()})`);
        console.log(`  since: ${since} (${new Date(since * 1000).toISOString()})`);
        console.log(`  fetching from ${new Date(since * 1000).toLocaleString()} to ${new Date(now * 1000).toLocaleString()}`);
      }
      
      const events = await batchFetchByAuthors({
        nostr,
        authors: pubkeys,
        limit,
        since,
        multiplier,
        onProgress: onProgress ?? (() => {}),
      });
      
      if (import.meta.env.DEV) {
        console.log(`[customFeedCache] Got ${events.length} events for feed ${feedId}`);
        if (events.length > 0) {
          const oldest = events.reduce((min, e) => e.created_at < min ? e.created_at : min, events[0].created_at);
          const newest = events.reduce((max, e) => e.created_at > max ? e.created_at : max, events[0].created_at);
          const timeSpan = (newest - oldest) / 3600;
          console.log(`[customFeedCache] Time span: ${timeSpan.toFixed(2)} hours`);
          console.log(`[customFeedCache] Oldest: ${new Date(oldest * 1000).toISOString()}`);
          console.log(`[customFeedCache] Newest: ${new Date(newest * 1000).toISOString()}`);
        }
      }
      
      // Save to custom feed cache (separate from global notes cache)
      await saveCustomFeedNotes(feedId, events);
      await setCustomFeedMetadata(feedId, { lastSync: Date.now(), pubkeyCount: pubkeys.length });
      
      return events;
    },
    enabled: enabled && pubkeys.length > 0,
    retry: 0, // No retry on failure
    staleTime: 5 * 60 * 1000, // 5 min — marks data stale but won't auto-refetch (refetchOnWindowFocus is off)
    refetchOnReconnect: false,
  });

  // Initialize from cache on first load
  useEffect(() => {
    if (!hasInitialized.current && isCustomFeedCacheLoaded()) {
      const cached = getCustomFeedNotesFromMemory(feedId);
      if (cached.length > 0) {
        if (import.meta.env.DEV) console.log(`[customFeedCache] Initializing feed ${feedId} with ${cached.length} cached notes`);
        queryClient.setQueryData(queryKey, cached);
      }
      hasInitialized.current = true;
    }
  }, [queryClient, queryKey, feedId]);

  // Load older notes for this custom feed
  const loadOlder = useCallback(async () => {
    const cached = query.data ?? [];
    if (cached.length === 0) return;
    
    const oldestTimestamp = cached.reduce((min, e) => e.created_at < min ? e.created_at : min, cached[0].created_at);
    
    // Fetch notes older than our current oldest
    const until = oldestTimestamp;
    const since = oldestTimestamp - (baseWindowSeconds * 3); // Go back 3x base window
    
    if (import.meta.env.DEV) {
      console.log(`[customFeedCache] Loading older notes for feed ${feedId}: until ${until} since ${since}`);
    }
    
    const events = await batchFetchByAuthors({
      nostr,
      authors: pubkeys,
      limit,
      until,
      since,
      onProgress: onProgress ?? (() => {}),
    });

    if (events.length > 0) {
      await mergeCustomFeedNotes(feedId, events);
      if (import.meta.env.DEV) console.log(`[customFeedCache] Added ${events.length} older notes to feed ${feedId}`);
      
      queryClient.setQueryData(queryKey, (prev: NostrEvent[] | undefined) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map(e => e.id));
        const newEvents = events.filter(e => !seen.has(e.id));
        return [...existing, ...newEvents].sort((a, b) => b.created_at - a.created_at);
      });
    }

    return events.length;
  }, [query.data, queryClient, queryKey, nostr, pubkeys, limit, baseWindowSeconds, feedId, onProgress]);

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
        if (import.meta.env.DEV) console.log(`[customFeedCache] Added ${added} newer notes to feed ${feedId}`);
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
  const key = getCustomFeedCacheKey(feedId);
  // Prune to most recent notes if over limit
  const pruned = events.length > MAX_NOTES_PER_FEED
    ? events.sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES_PER_FEED)
    : events;
  await idbSet(key, JSON.stringify(pruned));
  customFeedMemCache.set(feedId, pruned);
}

export async function mergeCustomFeedNotes(feedId: string, events: NostrEvent[]): Promise<number> {
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
      const key = getCustomFeedCacheKey(feedId);
      const stored = await idbGet(key);
      if (!stored) continue;
      const events: NostrEvent[] = JSON.parse(stored);
      if (events.length > MAX_NOTES_PER_FEED) {
        const pruned = events.sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES_PER_FEED);
        await idbSet(key, JSON.stringify(pruned));
        if (import.meta.env.DEV) console.log(`[customFeedCache] Pruned feed ${feedId}: ${events.length} → ${pruned.length}`);
      }
    }
  } catch {
    // Best-effort cleanup
  }
})();