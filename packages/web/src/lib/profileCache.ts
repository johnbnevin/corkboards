/**
 * Persistent profile cache for Nostr user metadata.
 * 
 * Features:
 * - Per-pubkey caching with no TTL
 * - Monthly refresh for cached profiles
 * - Uses IndexedDB via idb utilities
 * - JSON serialization for metadata
 */

import { idbGet, idbSet, idbRemove, idbKeys } from './idb';
import { genUserName } from './genUserName';
import type { NostrEvent } from '@nostrify/nostrify';

// Storage key prefix for profile cache
const PROFILE_CACHE_PREFIX = 'profile-cache:';

// Types
export interface CachedProfile {
  pubkey: string;
  name: string;
  picture?: string;
  about?: string;
  nip05?: string;
  display_name?: string;
  cached_at: number; // Unix timestamp
  refreshed_at: number; // Last refresh timestamp
}

// Helper functions
function getProfileCacheKey(pubkey: string): string {
  return `${PROFILE_CACHE_PREFIX}${pubkey}`;
}

function parseMetadata(content: string): Partial<CachedProfile> {
  try {
    const metadata = JSON.parse(content);
    return {
      name: metadata.name || metadata.display_name,
      picture: metadata.picture,
      about: metadata.about,
      nip05: metadata.nip05,
      display_name: metadata.display_name,
    };
  } catch {
    return {};
  }
}

// Core cache operations
export async function getCachedProfile(pubkey: string): Promise<CachedProfile | null> {
  const key = getProfileCacheKey(pubkey);
  const stored = await idbGet(key);
  
  if (!stored) {
    return null;
  }

  try {
    const profile: CachedProfile = JSON.parse(stored);
    return profile;
  } catch {
    // Invalid stored data, remove it
    await idbRemove(key);
    return null;
  }
}

export async function setCachedProfile(pubkey: string, event: NostrEvent): Promise<CachedProfile> {
  const metadata = parseMetadata(event.content);
  const now = Date.now();
  
  const profile: CachedProfile = {
    pubkey,
    name: metadata.name || genUserName(pubkey),
    picture: metadata.picture,
    about: metadata.about,
    nip05: metadata.nip05,
    display_name: metadata.display_name,
    cached_at: now,
    refreshed_at: now,
  };

  const key = getProfileCacheKey(pubkey);
  await idbSet(key, JSON.stringify(profile));
  
  return profile;
}

export async function removeCachedProfile(pubkey: string): Promise<void> {
  const key = getProfileCacheKey(pubkey);
  await idbRemove(key);
}

// Check if profile needs refresh (older than 30 days)
export function needsRefresh(profile: CachedProfile): boolean {
  const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - profile.refreshed_at > thirtyDaysInMs;
}

// Mark profile as refreshed (update refreshed_at timestamp)
export async function markProfileRefreshed(pubkey: string): Promise<void> {
  const profile = await getCachedProfile(pubkey);
  if (profile) {
    profile.refreshed_at = Date.now();
    const key = getProfileCacheKey(pubkey);
    await idbSet(key, JSON.stringify(profile));
  }
}

// Get multiple cached profiles
export async function getCachedProfiles(pubkeys: string[]): Promise<Map<string, CachedProfile>> {
  const results = new Map<string, CachedProfile>();
  
  // Use Promise.all to fetch profiles in parallel
  const profiles = await Promise.all(
    pubkeys.map(async (pubkey) => {
      const profile = await getCachedProfile(pubkey);
      return { pubkey, profile };
    })
  );

  // Filter out null results and add to map
  profiles.forEach(({ pubkey, profile }) => {
    if (profile) {
      results.set(pubkey, profile);
    }
  });

  return results;
}

// Set multiple cached profiles
export async function setCachedProfiles(events: NostrEvent[]): Promise<void> {
  // Use Promise.all to set profiles in parallel
  await Promise.all(
    events.map(async (event) => {
      await setCachedProfile(event.pubkey, event);
    })
  );
}

// Get profiles that need refresh
export async function getProfilesNeedingRefresh(pubkeys: string[]): Promise<string[]> {
  const cachedProfiles = await getCachedProfiles(pubkeys);
  const needRefresh: string[] = [];

  pubkeys.forEach(pubkey => {
    const profile = cachedProfiles.get(pubkey);
    if (!profile || needsRefresh(profile)) {
      needRefresh.push(pubkey);
    }
  });

  return needRefresh;
}

// Cleanup operations
export async function getAllCachedProfilePubkeys(): Promise<string[]> {
  const keys = await idbKeys();
  return keys
    .filter(key => key.startsWith(PROFILE_CACHE_PREFIX))
    .map(key => key.substring(PROFILE_CACHE_PREFIX.length));
}

export async function clearProfileCache(): Promise<void> {
  const pubkeys = await getAllCachedProfilePubkeys();
  await Promise.all(pubkeys.map(removeCachedProfile));
}

// Get cache statistics
export async function getProfileCacheStats(): Promise<{
  totalProfiles: number;
  profilesNeedingRefresh: number;
  oldestCache: number | null;
  newestCache: number | null;
}> {
  const pubkeys = await getAllCachedProfilePubkeys();
  const profiles = await getCachedProfiles(pubkeys);
  
  
  
  let profilesNeedingRefresh = 0;
  let oldestCache: number | null = null;
  let newestCache: number | null = null;

  profiles.forEach(profile => {
    if (needsRefresh(profile)) {
      profilesNeedingRefresh++;
    }
    
    if (!oldestCache || profile.cached_at < oldestCache) {
      oldestCache = profile.cached_at;
    }
    
    if (!newestCache || profile.cached_at > newestCache) {
      newestCache = profile.cached_at;
    }
  });

  return {
    totalProfiles: profiles.size,
    profilesNeedingRefresh,
    oldestCache,
    newestCache,
  };
}