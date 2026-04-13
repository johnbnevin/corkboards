/**
 * useCustomFeedNotesCache — MMKV-backed cache for custom feed (corkboard) notes.
 * Mobile port of packages/web/src/hooks/useCustomFeedNotesCache.ts.
 *
 * Replaces IndexedDB (idb) with MMKV for persistent storage.
 * In-memory Map mirrors the web's memCache for fast synchronous access.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { batchFetchByAuthors } from './useCustomFeed';
import { mobileStorage } from '../storage/MmkvStorage';
import { baseTimeWindow } from '@core/rss';
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
  multiplier?: number;
  onProgress?: (loaded: number, total: number) => void;
}

// ============================================================================
// Custom Feed Cache Storage (MMKV-backed, replaces web's IndexedDB)
// ============================================================================

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

// In-memory cache for custom feeds (mirrors web's customFeedMemCache)
const customFeedMemCache = new Map<string, NostrEvent[]>();
let customFeedCacheLoaded = false;

export async function saveCustomFeedNotes(feedId: string, events: NostrEvent[]): Promise<void> {
  const key = getCustomFeedCacheKey(feedId);
  const pruned = events.length > MAX_NOTES_PER_FEED
    ? events.sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES_PER_FEED)
    : events;
  mobileStorage.setSync(key, JSON.stringify(pruned));
  customFeedMemCache.set(feedId, pruned);
}

export async function mergeCustomFeedNotes(feedId: string, events: NostrEvent[]): Promise<number> {
  const existing = await getCustomFeedNotes(feedId);
  const existingIds = new Set(existing.map(e => e.id));

  const newEvents = events.filter(e => !existingIds.has(e.id));
  if (newEvents.length > 0) {
    let merged = [...existing, ...newEvents].sort((a, b) => b.created_at - a.created_at);
    if (merged.length > MAX_NOTES_PER_FEED) {
      merged = merged.slice(0, MAX_NOTES_PER_FEED);
    }
    const key = getCustomFeedCacheKey(feedId);
    mobileStorage.setSync(key, JSON.stringify(merged));
    customFeedMemCache.set(feedId, merged);
  }

  return newEvents.length;
}

export async function getCustomFeedNotes(feedId: string): Promise<NostrEvent[]> {
  // Check in-memory cache first
  if (customFeedMemCache.has(feedId)) {
    return customFeedMemCache.get(feedId) ?? [];
  }

  // Load from MMKV
  const key = getCustomFeedCacheKey(feedId);
  const stored = mobileStorage.getSync(key);

  if (!stored) {
    return [];
  }

  try {
    const events: NostrEvent[] = JSON.parse(stored);
    customFeedMemCache.set(feedId, events);
    return events;
  } catch {
    mobileStorage.removeSync(key);
    return [];
  }
}

export function getCustomFeedNotesFromMemory(feedId: string): NostrEvent[] {
  // Try memCache first, then fall back to MMKV (synchronous)
  if (customFeedMemCache.has(feedId)) {
    return customFeedMemCache.get(feedId) ?? [];
  }
  const key = getCustomFeedCacheKey(feedId);
  const stored = mobileStorage.getSync(key);
  if (!stored) return [];
  try {
    const events: NostrEvent[] = JSON.parse(stored);
    customFeedMemCache.set(feedId, events);
    return events;
  } catch {
    return [];
  }
}

export async function setCustomFeedMetadata(feedId: string, metadata: CustomFeedMetadata): Promise<void> {
  const key = getCustomFeedMetadataKey(feedId);
  mobileStorage.setSync(key, JSON.stringify(metadata));
}

export async function getCustomFeedMetadata(feedId: string): Promise<CustomFeedMetadata | null> {
  const key = getCustomFeedMetadataKey(feedId);
  const stored = mobileStorage.getSync(key);

  if (!stored) return null;

  try {
    return JSON.parse(stored);
  } catch {
    mobileStorage.removeSync(key);
    return null;
  }
}

export async function clearCustomFeedCache(feedId: string): Promise<void> {
  const cacheKey = getCustomFeedCacheKey(feedId);
  const metadataKey = getCustomFeedMetadataKey(feedId);

  mobileStorage.removeSync(cacheKey);
  mobileStorage.removeSync(metadataKey);
  customFeedMemCache.delete(feedId);
}

export function getAllCustomFeedIds(): string[] {
  try {
    const allKeys = mobileStorage.getSync ? getAllKeysSync() : [];
    return allKeys
      .filter(key => key.startsWith(CUSTOM_FEED_CACHE_PREFIX))
      .map(key => key.substring(CUSTOM_FEED_CACHE_PREFIX.length));
  } catch {
    return [];
  }
}

/** Synchronous key scan — uses the MMKV instance directly */
function getAllKeysSync(): string[] {
  // mobileStorage.keys() is async but returns MMKV.getAllKeys() which is sync
  // We access it through the sync MMKV API pattern used in cacheStore
  try {
    // MMKV keys are retrieved asynchronously through the KVStorage interface,
    // but for startup pruning we just skip it (lazy cleanup on next async call)
    return [];
  } catch {
    return [];
  }
}

export function isCustomFeedCacheLoaded(): boolean {
  return customFeedCacheLoaded;
}

// MMKV is ready immediately — mark cache as loaded
customFeedCacheLoaded = true;

// One-time cleanup: prune oversized feed caches (async, best-effort)
(async () => {
  try {
    const allKeys = await mobileStorage.keys();
    const feedKeys = allKeys.filter(key => key.startsWith(CUSTOM_FEED_CACHE_PREFIX));
    for (const key of feedKeys) {
      const stored = mobileStorage.getSync(key);
      if (!stored) continue;
      try {
        const events: NostrEvent[] = JSON.parse(stored);
        if (events.length > MAX_NOTES_PER_FEED) {
          const pruned = events.sort((a, b) => b.created_at - a.created_at).slice(0, MAX_NOTES_PER_FEED);
          mobileStorage.setSync(key, JSON.stringify(pruned));
          const feedId = key.substring(CUSTOM_FEED_CACHE_PREFIX.length);
          customFeedMemCache.set(feedId, pruned);
          if (__DEV__) console.log(`[customFeedCache] Pruned feed ${feedId}: ${events.length} -> ${pruned.length}`);
        }
      } catch {
        // Invalid data, remove it
        mobileStorage.removeSync(key);
      }
    }
  } catch {
    // Best-effort cleanup
  }
})();

// ============================================================================
// Hook
// ============================================================================

export function useCustomFeedNotesCache({
  feedId,
  pubkeys,
  enabled = true,
  limit,
  multiplier = 1,
  onProgress,
}: UseCustomFeedNotesCacheOptions) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const hasInitialized = useRef(false);

  const baseWindowSeconds = useMemo(() => {
    return baseTimeWindow(pubkeys.length);
  }, [pubkeys.length]);

  // Include feedId and pubkeys.length in key for proper cache isolation
  const queryKey = useMemo(() => ['custom-feed-cache', feedId, pubkeys.length] as const, [feedId, pubkeys.length]);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async ({ queryKey: qk }) => {
      const [, , pubkeyCount] = qk;
      if (__DEV__) console.log(`[customFeedCache] queryFn called for feed ${feedId}, authors: ${pubkeyCount}`);

      if (pubkeys.length === 0) {
        if (__DEV__) console.log(`[customFeedCache] No authors for feed ${feedId}, returning empty`);
        return [];
      }

      // Get existing data to check if we need to refetch
      const existingData = queryClient.getQueryData(qk) as NostrEvent[] | undefined;

      // If we already have events and pubkey count hasn't changed, skip
      if (existingData && existingData.length > 0) {
        if (__DEV__) console.log(`[customFeedCache] Using existing ${existingData.length} events for feed ${feedId}`);
        return existingData;
      }

      // Use fixed time window multiplied by the multiplier
      const timeWindowSeconds = baseWindowSeconds * multiplier;
      const now = Math.floor(Date.now() / 1000);
      const since = now - timeWindowSeconds;

      if (__DEV__) {
        console.log(`[customFeedCache] Fetching notes for feed ${feedId}:`);
        console.log(`  timeWindowSeconds: ${timeWindowSeconds} seconds = ${timeWindowSeconds / 3600} hours`);
        console.log(`  multiplier: ${multiplier}`);
      }

      const events = await batchFetchByAuthors({
        nostr,
        authors: pubkeys,
        limit,
        since,
        multiplier,
        onProgress: onProgress ?? (() => {}),
      });

      if (__DEV__) {
        console.log(`[customFeedCache] Got ${events.length} events for feed ${feedId}`);
      }

      // Save to custom feed cache
      await saveCustomFeedNotes(feedId, events);
      await setCustomFeedMetadata(feedId, { lastSync: Date.now(), pubkeyCount: pubkeys.length });

      return events;
    },
    enabled: enabled && pubkeys.length > 0,
    retry: 0,
    staleTime: 5 * 60 * 1000,
    refetchOnReconnect: false,
  });

  // Initialize from MMKV cache on first load
  useEffect(() => {
    if (!hasInitialized.current && isCustomFeedCacheLoaded()) {
      const cached = getCustomFeedNotesFromMemory(feedId);
      if (cached.length > 0) {
        if (__DEV__) console.log(`[customFeedCache] Initializing feed ${feedId} with ${cached.length} cached notes`);
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

    const until = oldestTimestamp;
    const since = oldestTimestamp - (baseWindowSeconds * 3);

    if (__DEV__) {
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
      if (__DEV__) console.log(`[customFeedCache] Added ${events.length} older notes to feed ${feedId}`);

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
        if (__DEV__) console.log(`[customFeedCache] Added ${added} newer notes to feed ${feedId}`);
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

  // Get notes filtered by pubkeys
  const getFilteredByPubkeys = useCallback((filterPubkeys: string[]) => {
    const cached = query.data ?? [];
    const pubkeySet = new Set(filterPubkeys);
    return cached.filter(e => pubkeySet.has(e.pubkey));
  }, [query.data]);

  // Track if there are more notes to load
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    if (query.data) {
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
