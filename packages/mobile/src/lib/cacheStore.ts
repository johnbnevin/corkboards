/**
 * cacheStore — MMKV-backed offline-first cache for Nostr profiles.
 *
 * Mirrors the web version (packages/web/src/lib/cacheStore.ts) but uses
 * MMKV instead of IndexedDB. MMKV is mmap-backed and synchronous, so
 * there's no need for a separate in-memory L1 layer — MMKV itself is
 * fast enough for render-path reads.
 *
 * Cache expiry: entries use a `cachedAt` timestamp. Stale entries are
 * evicted lazily on read (no background sweeper).
 */
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { mobileStorage } from '../storage/MmkvStorage';

const PROFILE_PREFIX = 'profile-cache:';

interface CachedProfile {
  pubkey: string;
  metadata: NostrMetadata | null;
  event: NostrEvent | null;
  cachedAt: number;
}

export function cacheProfile(
  pubkey: string,
  metadata: NostrMetadata | null,
  event: NostrEvent | null,
): void {
  try {
    const profile: CachedProfile = { pubkey, metadata, event, cachedAt: Date.now() };
    mobileStorage.setSync(PROFILE_PREFIX + pubkey, JSON.stringify(profile));
  } catch (error) {
    console.warn('[ProfileCache] Failed to cache profile:', error instanceof Error ? error.message : error);
  }
}

export function getCachedProfile(
  pubkey: string,
  maxAge: number = 24 * 60 * 60 * 1000,
): CachedProfile | null {
  try {
    const stored = mobileStorage.getSync(PROFILE_PREFIX + pubkey);
    if (!stored) return null;
    const profile: CachedProfile = JSON.parse(stored);
    if (Date.now() - profile.cachedAt > maxAge) return null;
    return profile;
  } catch {
    return null;
  }
}

export function getCachedProfileSync(pubkey: string): NostrMetadata | null {
  try {
    const stored = mobileStorage.getSync(PROFILE_PREFIX + pubkey);
    if (!stored) return null;
    const profile: CachedProfile = JSON.parse(stored);
    return profile.metadata ?? null;
  } catch {
    return null;
  }
}

/** Evict a single profile from cache (forces relay refetch) */
export function evictCachedProfile(pubkey: string): void {
  try {
    mobileStorage.removeSync(PROFILE_PREFIX + pubkey);
  } catch { /* best-effort */ }
}

/** Clear all cached profiles. Uses the async keys() API since MMKV's KVStorage
 *  interface doesn't expose synchronous key iteration. */
export async function clearProfileCache(): Promise<void> {
  try {
    const allKeys = await mobileStorage.keys();
    for (const key of allKeys) {
      if (key.startsWith(PROFILE_PREFIX)) {
        mobileStorage.removeSync(key);
      }
    }
  } catch (error) {
    console.warn('[ProfileCache] Failed to clear profile cache:', error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// Note Caching (for offline-first note lookups)
// Mirrors web's cacheStore note APIs (packages/web/src/lib/cacheStore.ts).
// ============================================================================

const NOTE_PREFIX = 'note-cache:';

interface CachedNote {
  id: string;
  event: NostrEvent;
  cachedAt: number;
}

export function cacheNote(event: NostrEvent): void {
  try {
    const note: CachedNote = { id: event.id, event, cachedAt: Date.now() };
    mobileStorage.setSync(NOTE_PREFIX + event.id, JSON.stringify(note));
  } catch (error) {
    console.warn('[NoteCache] Failed to cache note:', error instanceof Error ? error.message : error);
  }
}

export function cacheNotes(events: NostrEvent[]): void {
  for (const event of events) {
    cacheNote(event);
  }
}

export function getCachedNote(
  id: string,
  maxAge: number = 24 * 60 * 60 * 1000,
): CachedNote | null {
  try {
    const stored = mobileStorage.getSync(NOTE_PREFIX + id);
    if (!stored) return null;
    const note: CachedNote = JSON.parse(stored);
    if (Date.now() - note.cachedAt > maxAge) return null;
    return note;
  } catch {
    return null;
  }
}

export function getCachedNotes(
  ids: string[],
  maxAge: number = 24 * 60 * 60 * 1000,
): Map<string, CachedNote> {
  const results = new Map<string, CachedNote>();
  for (const id of ids) {
    const note = getCachedNote(id, maxAge);
    if (note) results.set(id, note);
  }
  return results;
}

// ============================================================================
// Cache Management
// ============================================================================

export async function clearCache(): Promise<void> {
  try {
    const allKeys = await mobileStorage.keys();
    for (const key of allKeys) {
      if (key.startsWith(PROFILE_PREFIX) || key.startsWith(NOTE_PREFIX)) {
        mobileStorage.removeSync(key);
      }
    }
  } catch (error) {
    console.warn('[Cache] Failed to clear cache:', error instanceof Error ? error.message : error);
  }
}
