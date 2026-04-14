/**
 * Mobile NostrProvider — NPool with outbox model routing.
 * Adapted from the web version; uses MMKV instead of IDB,
 * no BroadcastChannel (single-process mobile environment).
 */
import React, { createContext, useContext, useState, useMemo } from 'react';
import { NPool, NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent, NostrFilter, NPool as NPoolType } from '@nostrify/nostrify';
import { mobileStorage } from '../storage/MmkvStorage';
import { isSecureRelay } from '@core/nostrUtils';
import { FALLBACK_RELAYS, READ_ONLY_RELAYS, ZAP_RELAYS } from '@core/relayConstants';
export { FALLBACK_RELAYS, READ_ONLY_RELAYS, ZAP_RELAYS };

// ============================================================================
// Constants
// ============================================================================

const RELAY_CACHE_KEY = 'corkboard:relay-cache';
export const APP_CONFIG_KEY = 'corkboard:app-config';
const MAX_RELAY_CACHE = 3000; // 3000 vs 5000 on web — conservative mobile memory budget

// ── Differences from web NostrProvider ───────────────────────────────────────
// MAX_RELAY_CACHE: 3000 (mobile) vs 5000 (web) — conservative mobile memory budget
// BroadcastChannel: absent — React Native is single-process, no tab sync needed
// MMKV replaces IDB — same synchronous-cache semantics, platform-native API
// ────────────────────────────────���────────────────────────────────────────────

// Tiered relay routing thresholds (keep in sync with web NostrProvider)
const BULK_AUTHOR_THRESHOLD = 10;
const MAX_BULK_RELAYS = 8;
const MAX_AUTHORS_PER_FILTER = 500;

// ============================================================================
// Relay cache (module-level, like web)
// ============================================================================

let relayCache: Map<string, string[]> = new Map();

function loadRelayCache(): void {
  try {
    const stored = mobileStorage.getSync(RELAY_CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      relayCache = new Map(Object.entries(parsed) as [string, string[]][]);
    }
  } catch {
    // ignore
  }
}

let relayCacheSaveTimer: ReturnType<typeof setTimeout> | undefined;

function saveRelayCache(): void {
  // Debounce MMKV writes — relay cache updates are frequent (per-event)
  if (relayCacheSaveTimer) clearTimeout(relayCacheSaveTimer);
  relayCacheSaveTimer = setTimeout(() => {
    try {
      mobileStorage.setSync(RELAY_CACHE_KEY, JSON.stringify(Object.fromEntries(relayCache)));
    } catch {
      // ignore storage errors
    }
  }, 2000);
}

export function updateRelayCache(pubkey: string, relays: string[]): void {
  const secure = relays.filter(isSecureRelay);
  if (secure.length === 0) return;

  relayCache.delete(pubkey);
  relayCache.set(pubkey, secure);

  if (relayCache.size > MAX_RELAY_CACHE) {
    const excess = relayCache.size - MAX_RELAY_CACHE;
    let removed = 0;
    for (const key of relayCache.keys()) {
      if (removed >= excess) break;
      relayCache.delete(key);
      removed++;
    }
  }

  saveRelayCache();
}

/**
 * Clears the relay cache on logout to prevent relay routing hints from one user
 * leaking into the next user's session.
 */
export function clearRelayCache(): void {
  relayCache.clear();
  if (relayCacheSaveTimer) {
    clearTimeout(relayCacheSaveTimer);
    relayCacheSaveTimer = undefined;
  }
  try {
    mobileStorage.removeSync(RELAY_CACHE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function getRelayCache(pubkey: string): string[] {
  const relays = relayCache.get(pubkey);
  if (!relays) return [];
  // Move to end so least-recently-accessed entries are evicted first (true LRU)
  relayCache.delete(pubkey);
  relayCache.set(pubkey, relays);
  return relays;
}

// Get user's configured relays from MMKV (same format as web's APP_CONFIG_KEY in IDB).
// Keep in sync with web's getUserRelays() in packages/web/src/components/NostrProvider.tsx.
export function getUserRelays(): { read: string[]; write: string[] } {
  try {
    const stored = mobileStorage.getSync(APP_CONFIG_KEY);
    if (stored) {
      const config = JSON.parse(stored) as Record<string, unknown>;
      const relayMeta = config?.relayMetadata as Record<string, unknown> | undefined;
      const relayList = Array.isArray(relayMeta?.relays) ? relayMeta.relays as unknown[] : [];
      const isSecure = (url: unknown): url is string => typeof url === 'string' && isSecureRelay(url);
      return {
        read: relayList.filter(r => typeof r === 'object' && r !== null && (r as Record<string, unknown>).read === true && isSecure((r as Record<string, unknown>).url)).map(r => (r as { url: string }).url),
        write: relayList.filter(r => typeof r === 'object' && r !== null && (r as Record<string, unknown>).write === true && isSecure((r as Record<string, unknown>).url)).map(r => (r as { url: string }).url),
      };
    }
  } catch { /* ignore */ }
  return { read: [], write: [] };
}

// ============================================================================
// Pool factory
// ============================================================================

function createPool(): NPoolType {
  return new NPool({
    open(url: string) {
      return new NRelay1(url, { backoff: false });
    },

    // Tiered routing (keep in sync with web NostrProvider)
    reqRouter(filters: NostrFilter[]) {
      const routes = new Map<string, NostrFilter[]>();
      const relaysToQuery = new Set<string>();

      // Extract all authors from filters
      const authors: string[] = [];
      filters.forEach(f => {
        if (f.authors) f.authors.forEach(a => authors.push(a));
      });

      if (authors.length >= BULK_AUTHOR_THRESHOLD) {
        // Tier 1 — Bulk feed query: use user's read relays + FALLBACK_RELAYS, capped
        const userRelays = getUserRelays();
        userRelays.read.forEach(r => relaysToQuery.add(r));
        FALLBACK_RELAYS.forEach(r => relaysToQuery.add(r));
        READ_ONLY_RELAYS.forEach(r => relaysToQuery.add(r));
        const capped = Array.from(relaysToQuery).slice(0, MAX_BULK_RELAYS);

        for (const relay of capped) {
          if (authors.length <= MAX_AUTHORS_PER_FILTER) {
            routes.set(relay, filters);
          } else {
            // Batch author lists to avoid silent relay truncation
            const batchedFilters: NostrFilter[] = [];
            for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_FILTER) {
              const batch = authors.slice(i, i + MAX_AUTHORS_PER_FILTER);
              for (const filter of filters) {
                if (filter.authors) {
                  batchedFilters.push({ ...filter, authors: batch });
                } else {
                  if (i === 0) batchedFilters.push(filter);
                }
              }
            }
            routes.set(relay, batchedFilters);
          }
        }
      } else {
        // Tier 2 — Targeted query: full outbox model
        for (const author of authors) {
          const cached = getRelayCache(author);
          if (cached.length > 0) cached.slice(0, 3).forEach(r => relaysToQuery.add(r));
        }
        // Include the user's own read relays (matches web NostrProvider Tier 2 behaviour)
        getUserRelays().read.forEach(r => relaysToQuery.add(r));
        // Always include fallback + read-only relays — critical for #p queries (notifications)
        // where the user has read relays but the event may live on a fallback relay.
        FALLBACK_RELAYS.forEach(r => relaysToQuery.add(r));
        READ_ONLY_RELAYS.forEach(r => relaysToQuery.add(r));

        for (const relay of relaysToQuery) {
          routes.set(relay, filters);
        }
      }
      return routes;
    },

    eventRouter(event: NostrEvent) {
      const relays = new Set<string>();
      // 1. User's configured write relays (highest priority)
      getUserRelays().write.forEach(r => relays.add(r));
      // 2. Author's cached outbox relays (outbox model)
      const authorRelays = getRelayCache(event.pubkey);
      if (authorRelays.length > 0) authorRelays.slice(0, 3).forEach(r => relays.add(r));
      // 3. Fallback only if nothing else available
      if (relays.size === 0) FALLBACK_RELAYS.forEach(r => relays.add(r));
      return Array.from(relays);
    },
  });
}

// Initialize cache on load
loadRelayCache();

// ============================================================================
// Context
// ============================================================================

interface NostrContextValue {
  nostr: NPoolType;
}

const NostrContext = createContext<NostrContextValue | null>(null);

export function NostrProvider({ children }: { children: React.ReactNode }) {
  const [pool] = useState<NPoolType>(() => createPool());
  const value = useMemo(() => ({ nostr: pool }), [pool]);
  return <NostrContext.Provider value={value}>{children}</NostrContext.Provider>;
}

export function useNostr(): NostrContextValue {
  const ctx = useContext(NostrContext);
  if (!ctx) throw new Error('useNostr must be used within NostrProvider');
  return ctx;
}
