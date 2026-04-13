/**
 * Persistent two-level cache for follow notes using MMKV.
 *
 * Mobile port of packages/web/src/lib/notesCache.ts.
 *
 * L1: In-memory Map for hot reads (zero-copy, no parse overhead).
 * L2: MMKV-backed storage for persistence across app launches.
 *     Each note is stored as a separate MMKV key under the "notes-cache:" prefix
 *     so individual put/delete is O(1) without full-collection serialization.
 *
 * LRU eviction caps the cache at 3000 entries (vs 5000 on web) to stay
 * within mobile memory budgets. TTL is 1 hour — notes not accessed within
 * that window are lazily evicted on the next bulk read.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import { mobileStorage } from '../storage/MmkvStorage';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTES_PREFIX = 'notes-cache:';
const META_PREFIX = 'notes-meta:';
const MAX_CACHED_NOTES = 3000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// L1 — in-memory hot cache
// ---------------------------------------------------------------------------

let memCache = new Map<string, NostrEvent>();
let memCacheAccessTime = new Map<string, number>(); // LRU tracking
let cacheLoaded = false;
let sortedCache: NostrEvent[] | null = null; // memoized sorted result

// ---------------------------------------------------------------------------
// MMKV helpers (L2)
// ---------------------------------------------------------------------------

function mmkvPutNote(event: NostrEvent): void {
  try {
    mobileStorage.setSync(NOTES_PREFIX + event.id, JSON.stringify(event));
  } catch (e) {
    console.warn('[notesCache] MMKV put failed:', e instanceof Error ? e.message : e);
  }
}

function mmkvDeleteNote(id: string): void {
  try {
    mobileStorage.removeSync(NOTES_PREFIX + id);
  } catch {
    // best-effort
  }
}

function mmkvGetAllNoteKeys(): string[] {
  // getAllKeys is sync on MMKV but KVStorage exposes it async; use the sync
  // path from the underlying MMKV instance via getSync trick — we iterate
  // all keys via the async wrapper but since MMKV is sync it resolves inline.
  // For the init path we use the async keys() API.
  const keys: string[] = [];
  // We'll collect them via the async API called from loadNotesFromStorage()
  return keys;
}

// ---------------------------------------------------------------------------
// Initialisation — load L2 into L1
// ---------------------------------------------------------------------------

let _readyResolve: () => void;
export const notesCacheReady = new Promise<void>((resolve) => {
  _readyResolve = resolve;
});

async function loadNotesFromStorage(): Promise<NostrEvent[]> {
  const allKeys = await mobileStorage.keys();
  const noteKeys = allKeys.filter((k) => k.startsWith(NOTES_PREFIX));

  const now = Date.now();
  const newCache = new Map<string, NostrEvent>();
  const newAccessTimes = new Map<string, number>();

  for (const key of noteKeys) {
    try {
      const raw = mobileStorage.getSync(key);
      if (!raw) continue;
      const event: NostrEvent = JSON.parse(raw);
      newCache.set(event.id, event);
      newAccessTimes.set(event.id, now);
    } catch {
      // corrupt entry — remove it
      mobileStorage.removeSync(key);
    }
  }

  memCache = newCache;
  memCacheAccessTime = newAccessTimes;
  sortedCache = null;
  cacheLoaded = true;

  return Array.from(newCache.values()).sort((a, b) => b.created_at - a.created_at);
}

// Kick off init immediately on import
loadNotesFromStorage()
  .then(() => {
    if (__DEV__) console.log('[notesCache] Loaded', memCache.size, 'cached notes from MMKV');
    _readyResolve();
  })
  .catch((e) => {
    console.warn('[notesCache] Init failed:', e);
    cacheLoaded = true; // allow the app to proceed with an empty cache
    _readyResolve();
  });

// ---------------------------------------------------------------------------
// Public API — matches web exports
// ---------------------------------------------------------------------------

/**
 * Get all cached notes sorted by created_at descending.
 * Performs a lazy TTL sweep on each call.
 */
export function getCachedNotes(): NostrEvent[] {
  if (!cacheLoaded) return [];
  if (sortedCache) return sortedCache;

  // Lazy TTL sweep
  const now = Date.now();
  for (const [id, accessTime] of memCacheAccessTime) {
    if (now - accessTime > CACHE_TTL_MS) {
      memCache.delete(id);
      memCacheAccessTime.delete(id);
      mmkvDeleteNote(id);
    }
  }

  sortedCache = Array.from(memCache.values()).sort((a, b) => b.created_at - a.created_at);
  // Reset TTL window for surviving notes
  for (const event of sortedCache) {
    memCacheAccessTime.set(event.id, now);
  }
  return sortedCache;
}

/**
 * Replace the entire cache with the given events.
 * Writes all events to both L1 and L2, with LRU eviction.
 */
export function setCachedNotes(events: NostrEvent[]): void {
  if (events.length === 0) return;

  const now = Date.now();
  for (const event of events) {
    memCache.set(event.id, event);
    memCacheAccessTime.set(event.id, now);
    mmkvPutNote(event);
  }
  sortedCache = null;

  evictIfNeeded();
}

/**
 * Merge new events into the cache (deduplicating by id).
 * Returns the number of newly added events.
 */
export function mergeNotes(newEvents: NostrEvent[]): number {
  if (newEvents.length === 0) return 0;

  const now = Date.now();
  let added = 0;
  for (const event of newEvents) {
    if (!memCache.has(event.id)) {
      memCache.set(event.id, event);
      memCacheAccessTime.set(event.id, now);
      mmkvPutNote(event);
      added++;
    }
  }
  if (added === 0) return 0;
  sortedCache = null;

  evictIfNeeded();
  return added;
}

/**
 * Clear the entire notes cache (L1 + L2).
 */
export async function clearNotesCache(): Promise<void> {
  memCache.clear();
  memCacheAccessTime.clear();
  sortedCache = null;

  try {
    const allKeys = await mobileStorage.keys();
    for (const key of allKeys) {
      if (key.startsWith(NOTES_PREFIX) || key.startsWith(META_PREFIX)) {
        mobileStorage.removeSync(key);
      }
    }
  } catch (e) {
    console.warn('[notesCache] Failed to clear MMKV:', e instanceof Error ? e.message : e);
  }
}

/**
 * Get cache statistics.
 */
export function getNotesStats(): { size: number; loaded: boolean; maxSize: number } {
  return {
    size: memCache.size,
    loaded: cacheLoaded,
    maxSize: MAX_CACHED_NOTES,
  };
}

/**
 * Get the number of cached notes for a set of pubkeys.
 */
export function getCacheStatsForPubkeys(
  pubkeys: string[],
): { total: number; visible: number; dismissed: number; filtered: number } {
  const pubkeySet = new Set(pubkeys);
  let total = 0;
  for (const event of memCache.values()) {
    if (pubkeySet.has(event.pubkey)) total++;
  }
  return { total, visible: total, dismissed: 0, filtered: 0 };
}

/**
 * Export the cache as a JSON string (for backup/restore).
 */
export function exportNotesCache(): string {
  const events = getCachedNotes();
  return JSON.stringify({ version: 1, exportedAt: Date.now(), events }, null, 2);
}

/**
 * Import notes from a JSON string (for backup/restore).
 * Returns the number of imported events.
 */
export function importNotesCache(json: string): number {
  const data = JSON.parse(json);
  if (!data.events || !Array.isArray(data.events)) {
    throw new Error('Invalid cache format');
  }
  setCachedNotes(data.events as NostrEvent[]);
  return data.events.length;
}

export function isCacheLoaded(): boolean {
  return cacheLoaded;
}

export function getCacheSize(): number {
  return memCache.size;
}

// ---------------------------------------------------------------------------
// Cache metadata (lastSync, authorCount) — stored as individual MMKV keys
// ---------------------------------------------------------------------------

interface CacheMetadata {
  lastSync: number;
  authorCount: number;
}

export function getCacheMetadata(): CacheMetadata {
  const lastSync = mobileStorage.getSync(META_PREFIX + 'lastSync');
  const authorCount = mobileStorage.getSync(META_PREFIX + 'authorCount');
  return {
    lastSync: lastSync ? Number(lastSync) : 0,
    authorCount: authorCount ? Number(authorCount) : 0,
  };
}

export function setCacheMetadata(meta: Partial<CacheMetadata>): void {
  if (meta.lastSync !== undefined) {
    mobileStorage.setSync(META_PREFIX + 'lastSync', String(meta.lastSync));
  }
  if (meta.authorCount !== undefined) {
    mobileStorage.setSync(META_PREFIX + 'authorCount', String(meta.authorCount));
  }
}

// ---------------------------------------------------------------------------
// Internal — LRU eviction
// ---------------------------------------------------------------------------

function evictIfNeeded(): void {
  if (memCache.size <= MAX_CACHED_NOTES * 0.9) return;
  if (memCache.size <= MAX_CACHED_NOTES) return;

  // Sort by access time ascending (oldest first = least recently used)
  const byAccess = Array.from(memCache.keys()).sort(
    (a, b) => (memCacheAccessTime.get(a) ?? 0) - (memCacheAccessTime.get(b) ?? 0),
  );

  const toRemove = byAccess.slice(0, byAccess.length - MAX_CACHED_NOTES);
  for (const id of toRemove) {
    memCache.delete(id);
    memCacheAccessTime.delete(id);
    mmkvDeleteNote(id);
  }
  sortedCache = null;
}
