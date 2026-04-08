/**
 * cacheStore — two-level offline-first cache for Nostr profiles and notes.
 *
 * ## Cache layers
 *
 * L1 — in-memory Map (`memProfileCache`, max 200 entries, FIFO eviction)
 *   - Fastest possible lookup; survives React re-renders but not page reload.
 *   - Used for profiles only (notes don't benefit from a small hot-set).
 *
 * L2 — IndexedDB via `idb` library (`corkboard-cache` database)
 *   - Survives page reload; used as the persistent backing store.
 *   - Profiles and notes each live in their own object store.
 *
 * ## Cache flow (profile read)
 * 1. Check L1 (sync, instant). If hit and within maxAge → return.
 * 2. Check L2 (async, IDB). If hit and within maxAge → promote to L1, return.
 * 3. Cache miss → caller must fetch from relay and call `cacheProfile()`.
 *
 * ## Cache expiry
 * Both levels use a `cachedAt` timestamp. Callers pass `maxAge` (default 24 h).
 * Stale entries are evicted lazily (on read) — no background sweeper.
 *
 * ## When to use this vs notesCache.ts
 * - `cacheStore` (this file): individual profile/note lookups by ID or pubkey.
 *   Used by `useAuthor`, `useThread`, note embeds, etc.
 * - `notesCache.ts`: bulk feed storage (10k+ notes) with IDB persistence and
 *   time-window pagination. Used only by the follow/custom-feed hooks.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';

const DB_NAME = 'corkboard-cache';
const DB_VERSION = 1;

interface CachedProfile {
  pubkey: string;
  metadata: NostrMetadata | null;
  event: NostrEvent | null;
  cachedAt: number;
}

interface CachedNote {
  id: string;
  event: NostrEvent;
  cachedAt: number;
}

// ─── In-memory L1 cache (fastest access) ───────────────────────────────────────
// Stores recently-accessed profiles for instant lookup during scroll/render.
// Cleared on page unload (not persisted).
const memProfileCache = new Map<string, CachedProfile>();
const MEM_CACHE_MAX_SIZE = 200;

function addToMemCache(pubkey: string, profile: CachedProfile): void {
  // LRU: delete-then-reinsert moves entry to Map tail (most-recently-used)
  memProfileCache.delete(pubkey);
  if (memProfileCache.size >= MEM_CACHE_MAX_SIZE) {
    const oldest = memProfileCache.keys().next().value;
    if (oldest) memProfileCache.delete(oldest);
  }
  memProfileCache.set(pubkey, profile);
}

function getFromMemCache(pubkey: string, maxAge: number): CachedProfile | null {
  const profile = memProfileCache.get(pubkey);
  if (!profile) return null;
  if (Date.now() - profile.cachedAt > maxAge) {
    memProfileCache.delete(pubkey);
    return null;
  }
  // Refresh position in LRU order on access
  memProfileCache.delete(pubkey);
  memProfileCache.set(pubkey, profile);
  return profile;
}

// Internal store types (kept for potential future IndexedDB schema migrations)
interface _ProfileStore {
  profiles: Record<string, CachedProfile>;
}

interface _NoteStore {
  notes: Record<string, CachedNote>;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

async function openDatabase(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('profiles')) {
          db.createObjectStore('profiles');
        }
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes');
        }
      },
    });
  }
  return dbPromise;
}

// ============================================================================
// Profile Caching (for offline-first profile lookups)
// ============================================================================

export async function cacheProfile(
  pubkey: string,
  metadata: NostrMetadata | null,
  event: NostrEvent | null
): Promise<void> {
  try {
    const profile: CachedProfile = {
      pubkey,
      metadata,
      event,
      cachedAt: Date.now(),
    };
    
    addToMemCache(pubkey, profile);
    
    const db = await openDatabase();
    await db.put('profiles', profile, pubkey);
  } catch (error) {
    console.warn('[ProfileCache] Failed to cache profile:', error);
  }
}

export async function getCachedProfile(
  pubkey: string,
  maxAge: number = 24 * 60 * 60 * 1000
): Promise<CachedProfile | null> {
  const memCached = getFromMemCache(pubkey, maxAge);
  if (memCached) return memCached;
  
  try {
    const db = await openDatabase();
    const profile = await db.get('profiles', pubkey);
    
    if (!profile) return null;
    
    const age = Date.now() - profile.cachedAt;
    if (age > maxAge) return null;
    
    addToMemCache(pubkey, profile);
    
    return profile;
  } catch (error) {
    console.warn('[ProfileCache] Failed to get cached profile:', error);
    return null;
  }
}

export async function getCachedProfiles(
  pubkeys: string[],
  maxAge: number = 24 * 60 * 60 * 1000
): Promise<Map<string, CachedProfile>> {
  const results = new Map<string, CachedProfile>();
  const uncachedPubkeys: string[] = [];
  
  for (const pubkey of pubkeys) {
    const memCached = getFromMemCache(pubkey, maxAge);
    if (memCached) {
      results.set(pubkey, memCached);
    } else {
      uncachedPubkeys.push(pubkey);
    }
  }
  
  if (uncachedPubkeys.length === 0) return results;
  
  try {
    const db = await openDatabase();
    const now = Date.now();
    const tx = db.transaction('profiles', 'readonly');
    const store = tx.objectStore('profiles');
    const profileResults = await Promise.all(uncachedPubkeys.map(pk => store.get(pk)));
    await tx.done;
    for (let i = 0; i < uncachedPubkeys.length; i++) {
      const profile = profileResults[i];
      if (profile && (now - profile.cachedAt) <= maxAge) {
        results.set(uncachedPubkeys[i], profile);
        addToMemCache(uncachedPubkeys[i], profile);
      }
    }
  } catch (error) {
    console.warn('[ProfileCache] Failed to get cached profiles:', error);
  }
  
  return results;
}

export function getCachedProfileSync(pubkey: string): NostrMetadata | null {
  const profile = memProfileCache.get(pubkey);
  return profile?.metadata ?? null;
}

export function clearMemCache(): void {
  memProfileCache.clear();
}

// ============================================================================
// Note Caching (for offline-first note lookups)
// ============================================================================

export async function cacheNote(event: NostrEvent): Promise<void> {
  try {
    const db = await openDatabase();
    const note: CachedNote = {
      id: event.id,
      event,
      cachedAt: Date.now(),
    };
    await db.put('notes', note, event.id);
  } catch (error) {
    console.warn('[NoteCache] Failed to cache note:', error);
  }
}

export async function cacheNotes(events: NostrEvent[]): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction('notes', 'readwrite');
    
    await Promise.all([
      ...events.map(async (event) => {
        const note: CachedNote = {
          id: event.id,
          event,
          cachedAt: Date.now(),
        };
        await tx.store.put(note);
      }),
      tx.done,
    ]);
  } catch (error) {
    console.warn('[NoteCache] Failed to cache notes:', error);
  }
}

export async function getCachedNote(
  id: string,
  maxAge: number = 24 * 60 * 60 * 1000
): Promise<CachedNote | null> {
  try {
    const db = await openDatabase();
    const note = await db.get('notes', id);
    
    if (!note) return null;
    
    const age = Date.now() - note.cachedAt;
    if (age > maxAge) return null;
    
    return note;
  } catch (error) {
    console.warn('[NoteCache] Failed to get cached note:', error);
    return null;
  }
}

export async function getCachedNotes(
  ids: string[],
  maxAge: number = 24 * 60 * 60 * 1000
): Promise<Map<string, CachedNote>> {
  const results = new Map<string, CachedNote>();
  
  try {
    const db = await openDatabase();
    const now = Date.now();
    const tx = db.transaction('notes', 'readonly');
    const store = tx.objectStore('notes');
    const noteResults = await Promise.all(ids.map(id => store.get(id)));
    await tx.done;
    for (let i = 0; i < ids.length; i++) {
      const note = noteResults[i];
      if (note && (now - note.cachedAt) <= maxAge) {
        results.set(ids[i], note);
      }
    }
  } catch (error) {
    console.warn('[NoteCache] Failed to get cached notes:', error);
  }
  
  return results;
}

// ============================================================================
// Cache Management
// ============================================================================

export async function clearCache(): Promise<void> {
  try {
    const db = await openDatabase();
    await db.clear('profiles');
    await db.clear('notes');
    // Close connection so deleteDatabase() won't be blocked during logout
    db.close();
    dbPromise = null;
  } catch (error) {
    console.warn('[Cache] Failed to clear cache:', error);
  }
}

export async function getCacheStats(): Promise<{ profiles: number; notes: number }> {
  try {
    const db = await openDatabase();
    const profileCount = await db.count('profiles');
    const noteCount = await db.count('notes');
    return { profiles: profileCount, notes: noteCount };
  } catch (error) {
    console.warn('[Cache] Failed to get cache stats:', error);
    return { profiles: 0, notes: 0 };
  }
}
