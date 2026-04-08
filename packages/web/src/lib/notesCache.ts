/**
 * Persistent cache for follow notes using IndexedDB.
 *
 * Provides:
 * - Load/save notes with deduplication
 * - Cache invalidation and size management
 * - Sync access via in-memory cache after init
 */
import { idbReady } from './idb';

const NOTES_DB_NAME = 'corkboard-notes';
const NOTES_STORE_NAME = 'events';
const METADATA_STORE_NAME = 'metadata';
const NOTES_DB_VERSION = 1;
const MAX_CACHED_NOTES = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — evict notes not accessed within this window

let notesDb: IDBDatabase | null = null;

let memCache = new Map<string, NostrEvent>();
let memCacheAccessTime = new Map<string, number>(); // LRU tracking: last-access timestamp per id
let cacheLoaded = false;
let sortedCache: NostrEvent[] | null = null; // memoized sorted result — invalidated on mutation
let loadingPromise: Promise<NostrEvent[]> | null = null; // singleton to prevent concurrent double-loads

import type { NostrEvent } from '@nostrify/nostrify';

interface CacheMetadata {
  lastSync: number;
  authorCount: number;
}

function openNotesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTES_DB_NAME, NOTES_DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTES_STORE_NAME)) {
        const store = db.createObjectStore(NOTES_STORE_NAME, { keyPath: 'id' });
        store.createIndex('pubkey', 'pubkey', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        db.createObjectStore(METADATA_STORE_NAME);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getNotesDb(): Promise<IDBDatabase> {
  if (!notesDb) notesDb = await openNotesDb();
  return notesDb;
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
}

async function _loadNotesFromCache(): Promise<NostrEvent[]> {
  const db = await getNotesDb();
  const tx = db.transaction(NOTES_STORE_NAME, 'readonly');
  const store = tx.objectStore(NOTES_STORE_NAME);
  const events = await wrapRequest(store.getAll()) as NostrEvent[];

  // Build new map first, then swap atomically
  const now = Date.now();
  const newCache = new Map<string, NostrEvent>();
  const newAccessTimes = new Map<string, number>();
  for (const event of events) {
    newCache.set(event.id, event);
    newAccessTimes.set(event.id, now);
  }
  memCache = newCache;
  memCacheAccessTime = newAccessTimes;
  sortedCache = null;
  cacheLoaded = true;

  return events.sort((a, b) => b.created_at - a.created_at);
}

export function loadNotesFromCache(): Promise<NostrEvent[]> {
  if (!loadingPromise) {
    loadingPromise = _loadNotesFromCache().finally(() => { loadingPromise = null; });
  }
  return loadingPromise;
}

export function getNotesFromMemory(): NostrEvent[] {
  if (!cacheLoaded) return [];
  if (sortedCache) return [...sortedCache];

  // Lazy TTL sweep: evict notes not accessed within CACHE_TTL_MS
  const now = Date.now();
  for (const [id, accessTime] of memCacheAccessTime) {
    if (now - accessTime > CACHE_TTL_MS) {
      memCache.delete(id);
      memCacheAccessTime.delete(id);
    }
  }

  sortedCache = Array.from(memCache.values()).sort((a, b) => b.created_at - a.created_at);
  // Touch all surviving notes so the TTL window resets from this bulk read
  for (const event of sortedCache) {
    memCacheAccessTime.set(event.id, now);
  }
  return sortedCache;
}

export async function saveNotesToCache(events: NostrEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Update memCache first
  const now = Date.now();
  for (const event of events) {
    memCache.set(event.id, event);
    memCacheAccessTime.set(event.id, now);
  }
  sortedCache = null; // invalidate memoized sort

  // Determine if pruning is needed — evict LRU (least-recently-accessed) entries
  let toRemoveIds: string[] = [];
  if (memCache.size > MAX_CACHED_NOTES * 0.9) {
    // Sort by access time ascending (oldest access first = least recently used)
    const byAccess = Array.from(memCache.keys())
      .sort((a, b) => (memCacheAccessTime.get(a) ?? 0) - (memCacheAccessTime.get(b) ?? 0));
    if (byAccess.length > MAX_CACHED_NOTES) {
      toRemoveIds = byAccess.slice(0, byAccess.length - MAX_CACHED_NOTES);
      for (const id of toRemoveIds) {
        memCache.delete(id);
        memCacheAccessTime.delete(id);
      }
      sortedCache = null;
    }
  }

  // Single transaction for both write and prune
  const db = await getNotesDb();
  const tx = db.transaction(NOTES_STORE_NAME, 'readwrite');
  const store = tx.objectStore(NOTES_STORE_NAME);

  for (const event of events) {
    store.put(event);
  }
  for (const id of toRemoveIds) {
    store.delete(id);
  }

  await waitForTransaction(tx);
}

export async function mergeNotesToCache(newEvents: NostrEvent[]): Promise<number> {
  if (newEvents.length === 0) return 0;

  // Update memCache first
  const now = Date.now();
  let added = 0;
  const eventsToWrite: NostrEvent[] = [];
  for (const event of newEvents) {
    if (!memCache.has(event.id)) {
      memCache.set(event.id, event);
      memCacheAccessTime.set(event.id, now);
      eventsToWrite.push(event);
      added++;
    }
  }
  if (added === 0) return 0;
  sortedCache = null;

  // Determine if pruning is needed — evict LRU entries
  let toRemoveIds: string[] = [];
  if (memCache.size > MAX_CACHED_NOTES * 0.9) {
    const byAccess = Array.from(memCache.keys())
      .sort((a, b) => (memCacheAccessTime.get(a) ?? 0) - (memCacheAccessTime.get(b) ?? 0));
    if (byAccess.length > MAX_CACHED_NOTES) {
      toRemoveIds = byAccess.slice(0, byAccess.length - MAX_CACHED_NOTES);
      for (const id of toRemoveIds) {
        memCache.delete(id);
        memCacheAccessTime.delete(id);
      }
      sortedCache = null;
    }
  }

  // Single transaction for both write and prune
  const db = await getNotesDb();
  const tx = db.transaction(NOTES_STORE_NAME, 'readwrite');
  const store = tx.objectStore(NOTES_STORE_NAME);

  for (const event of eventsToWrite) {
    store.put(event);
  }
  for (const id of toRemoveIds) {
    store.delete(id);
  }

  await waitForTransaction(tx);
  return added;
}

export async function clearNotesCache(): Promise<void> {
  memCache.clear();
  memCacheAccessTime.clear();
  sortedCache = null;
  const db = await getNotesDb();
  const tx = db.transaction(NOTES_STORE_NAME, 'readwrite');
  const store = tx.objectStore(NOTES_STORE_NAME);
  await wrapRequest(store.clear());
  // Close connection so deleteDatabase() won't be blocked during logout
  db.close();
  notesDb = null;
}

export async function pruneOldNotes(keepCount: number = MAX_CACHED_NOTES): Promise<number> {
  if (memCache.size <= keepCount) return 0;

  // Evict least-recently-accessed notes
  const byAccess = Array.from(memCache.keys())
    .sort((a, b) => (memCacheAccessTime.get(a) ?? 0) - (memCacheAccessTime.get(b) ?? 0));
  const toRemoveIds = byAccess.slice(0, byAccess.length - keepCount);

  const db = await getNotesDb();
  const tx = db.transaction(NOTES_STORE_NAME, 'readwrite');
  const store = tx.objectStore(NOTES_STORE_NAME);

  for (const id of toRemoveIds) {
    memCache.delete(id);
    memCacheAccessTime.delete(id);
    store.delete(id);
  }
  sortedCache = null;

  await waitForTransaction(tx);
  return toRemoveIds.length;
}

export async function getCacheMetadata(): Promise<CacheMetadata> {
  const db = await getNotesDb();
  const tx = db.transaction(METADATA_STORE_NAME, 'readonly');
  const store = tx.objectStore(METADATA_STORE_NAME);
  
  const lastSync = await wrapRequest(store.get('lastSync')) as number | undefined;
  const authorCount = await wrapRequest(store.get('authorCount')) as number | undefined;
  
  return {
    lastSync: lastSync ?? 0,
    authorCount: authorCount ?? 0,
  };
}

export async function setCacheMetadata(meta: Partial<CacheMetadata>): Promise<void> {
  const db = await getNotesDb();
  const tx = db.transaction(METADATA_STORE_NAME, 'readwrite');
  const store = tx.objectStore(METADATA_STORE_NAME);
  
  if (meta.lastSync !== undefined) store.put(meta.lastSync, 'lastSync');
  if (meta.authorCount !== undefined) store.put(meta.authorCount, 'authorCount');
  
  await waitForTransaction(tx);
}

export async function exportNotesCache(): Promise<string> {
  const events = getNotesFromMemory();
  return JSON.stringify({
    version: 1,
    exportedAt: Date.now(),
    events,
  }, null, 2);
}

export async function importNotesCache(json: string): Promise<number> {
  const data = JSON.parse(json);
  if (!data.events || !Array.isArray(data.events)) {
    throw new Error('Invalid cache format');
  }
  
  await saveNotesToCache(data.events as NostrEvent[]);
  return data.events.length;
}

export function getCacheSize(): number {
  return memCache.size;
}

export function getCacheStatsForPubkeys(pubkeys: string[]): { total: number; visible: number; dismissed: number; filtered: number } {
  const pubkeySet = new Set(pubkeys);
  let total = 0;

  for (const event of memCache.values()) {
    if (pubkeySet.has(event.pubkey)) {
      total++;
    }
  }

  // Dismissed/visible/filtered counts are computed in MultiColumnClient from
  // the actual deduplicatedNotes array + isDismissed hook, which has access to
  // the correct IndexedDB-backed dismissed list. This function only provides
  // the total count from the notes memCache.
  return { total, visible: total, dismissed: 0, filtered: 0 };
}

export function isCacheLoaded(): boolean {
  return cacheLoaded;
}

let _notesReadyResolve: () => void;
export const notesCacheReady = new Promise<void>((resolve) => {
  _notesReadyResolve = resolve;
});

async function initNotesCache(): Promise<void> {
  await idbReady;
  await loadNotesFromCache();
  if (import.meta.env.DEV) console.log('[notesCache] Loaded', memCache.size, 'cached notes from IndexedDB');
  _notesReadyResolve();
}

initNotesCache();

// Close IndexedDB on page unload to prevent stale connections
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (notesDb) {
      notesDb.close();
      notesDb = null;
    }
  });
}
