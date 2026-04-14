import React, { useState, useEffect, useMemo } from 'react';
import { NostrEvent, NostrFilter, NPool, NRelay1 } from '@nostrify/nostrify';
import { NostrContext } from '@nostrify/react';
import { idbGetSync, idbSetSync, idbReady } from '@/lib/idb';
import { isSecureRelay } from '@core/nostrUtils';
// Re-exported for backwards compatibility — canonical source is @/lib/relayConstants
export { FALLBACK_RELAYS, READ_ONLY_RELAYS } from '@/lib/relayConstants';
import { FALLBACK_RELAYS, READ_ONLY_RELAYS } from '@/lib/relayConstants';

interface NostrProviderProps {
  children: React.ReactNode;
}

// Storage keys
const RELAY_CACHE_KEY = 'corkboard:relay-cache';
const APP_CONFIG_KEY = 'corkboard:app-config';

// Debug flag - set to false in production
const DEBUG = false;

// ============================================================================
// Relay Cache with BroadcastChannel for cross-tab sync
// ============================================================================

// Map of pubkey -> array of relay URLs (LRU-evicted at MAX_RELAY_CACHE entries)
const MAX_RELAY_CACHE = 5000;

// Tiered relay routing thresholds (see reqRouter below)
const BULK_AUTHOR_THRESHOLD = 10; // >= this many authors → bulk tier (no per-author expansion)
const MAX_BULK_RELAYS = 8;        // cap on relay count for bulk feed queries
let relayCache: Map<string, string[]> = new Map();

// BroadcastChannel for cross-tab communication (replaces localStorage polling)
let broadcastChannel: BroadcastChannel | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (!broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel('corkboard-relay-cache');
    } catch {
      // BroadcastChannel not supported
    }
  }
  return broadcastChannel;
}

// Log debug messages only in debug mode
function debugLog(...args: unknown[]) {
  if (DEBUG) {
    console.log('[NostrProvider]', ...args);
  }
}

// Load relay cache from IDB sync cache on init
function loadRelayCache(): void {
  try {
    const stored = idbGetSync(RELAY_CACHE_KEY);
    if (stored) {
      let parsed: unknown;
      try { parsed = JSON.parse(stored); } catch { return; }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      const newCache = new Map<string, string[]>();
      for (const [pubkey, relays] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof pubkey === 'string' && Array.isArray(relays)) {
          const secure = (relays as unknown[]).filter((r): r is string => typeof r === 'string' && isSecureRelay(r));
          if (secure.length > 0) newCache.set(pubkey, secure);
        }
      }
      relayCache = newCache;
      debugLog('Loaded relay cache:', relayCache.size, 'entries');
    }
  } catch {
    // Ignore storage errors
  }
}

// Debounce IDB persistence to avoid writing on every single event
let relayCacheSaveTimer: ReturnType<typeof setTimeout> | undefined;

// Flush relay cache to IDB immediately (for beforeunload/visibilitychange)
function flushRelayCacheToIdb(): void {
  try {
    const obj = Object.fromEntries(relayCache);
    idbSetSync(RELAY_CACHE_KEY, JSON.stringify(obj));
  } catch { /* ignore storage errors */ }
}

// Save relay cache to IDB and notify other tabs
function saveRelayCache(pubkey?: string, relays?: string[]): void {
  try {
    // Broadcast only the changed entry (not the entire cache)
    const channel = getBroadcastChannel();
    if (channel && pubkey && relays) {
      channel.postMessage({ type: 'relay-cache-entry', pubkey, relays });
    }

    // Debounce IDB write — relay cache updates are frequent (per-event)
    if (relayCacheSaveTimer) clearTimeout(relayCacheSaveTimer);
    relayCacheSaveTimer = setTimeout(() => {
      flushRelayCacheToIdb();
    }, 2000);
  } catch {
    // Ignore storage errors
  }
}

// Get user's configured relays from IDB sync cache
// eslint-disable-next-line react-refresh/only-export-components
export function getUserRelays(): { read: string[]; write: string[] } {
  try {
    const stored = idbGetSync(APP_CONFIG_KEY);
    if (stored) {
      let config: unknown;
      try { config = JSON.parse(stored); } catch { return { read: [], write: [] }; }
      if (typeof config !== 'object' || config === null) return { read: [], write: [] };
      const relays = (config as Record<string, unknown>)?.relayMetadata as unknown;
      const relayList = Array.isArray((relays as Record<string, unknown>)?.relays) ? (relays as Record<string, unknown>).relays as unknown[] : [];
      return {
        read: relayList.filter((r): r is { read: boolean; url: string } => typeof r === 'object' && r !== null && (r as Record<string, unknown>).read === true).map(r => r.url).filter(isSecureRelay),
        write: relayList.filter((r): r is { write: boolean; url: string } => typeof r === 'object' && r !== null && (r as Record<string, unknown>).write === true).map(r => r.url).filter(isSecureRelay),
      };
    }
  } catch {
    // Ignore storage errors
  }
  return { read: [], write: [] };
}

// Update relay cache (called by useNip65Relays and other components)
// eslint-disable-next-line react-refresh/only-export-components
export function updateRelayCache(pubkey: string, relays: string[]) {
  const secureRelays = relays.filter(isSecureRelay);
  if (secureRelays.length > 0) {
    // LRU: delete first so re-insertion moves key to end of Map iteration order
    relayCache.delete(pubkey);
    relayCache.set(pubkey, secureRelays);

    // Evict oldest entries when cache exceeds limit
    if (relayCache.size > MAX_RELAY_CACHE) {
      const excess = relayCache.size - MAX_RELAY_CACHE;
      let removed = 0;
      for (const key of relayCache.keys()) {
        if (removed >= excess) break;
        relayCache.delete(key);
        removed++;
      }
    }

    saveRelayCache(pubkey, secureRelays);
  }
}

/** Clear relay cache on account switch so stale relay data doesn't leak between users */
// eslint-disable-next-line react-refresh/only-export-components
export function clearRelayCache(): void {
  relayCache = new Map();
}

// Get cached relays for a pubkey (updates LRU order on every access)
// eslint-disable-next-line react-refresh/only-export-components
export function getRelayCache(pubkey: string): string[] {
  const relays = relayCache.get(pubkey);
  if (!relays) return [];
  // Move to end so least-recently-accessed entries are evicted first
  relayCache.delete(pubkey);
  relayCache.set(pubkey, relays);
  return relays;
}

// Extract authors from filters for outbox routing
function extractAuthorsFromFilters(filters: NostrFilter[]): string[] {
  const authors = new Set<string>();
  filters.forEach(filter => {
    if (filter.authors) {
      filter.authors.forEach(author => authors.add(author));
    }
  });
  return Array.from(authors);
}

// ─── Outbox Model Relay Routing ──────────────────────────────────────────────
//
// createPool() implements the NIP-65 outbox model with two tiers:
//
//   reqRouter:
//     Tier 1 — Bulk feed queries (authors >= BULK_AUTHOR_THRESHOLD):
//       Use user's configured read relays + FALLBACK_RELAYS, capped at
//       MAX_BULK_RELAYS. No per-author relay expansion. This caps WebSocket
//       connections to 4–8 total instead of potentially 900+ on large feeds.
//
//     Tier 2 — Targeted queries (authors < BULK_AUTHOR_THRESHOLD):
//       Full outbox model: per-author relays (up to 3 each) + user's read
//       relays + FALLBACK_RELAYS. Correct for thread fetches, profile lookups,
//       single-event fetches where precision matters.
//
//   eventRouter: Publishes go to the user's configured write relays plus the
//                event author's own cached relays. Falls back to FALLBACK_RELAYS
//                only when the user has no relays configured.
//
// The relayCache is a module-level LRU Map (MAX_RELAY_CACHE entries) populated
// by useNip65Relays as profiles are fetched, persisted to IDB for cold-start
// performance, and synced across browser tabs via BroadcastChannel.
//
// backoff: false on NRelay1 means connections open on-demand only — they are
// not kept alive between queries. This is intentional: relay connections are
// cheap to open and the pool may route to hundreds of different relays.
// ─────────────────────────────────────────────────────────────────────────────
function createPool(): NPool {
  return new NPool({
    open(url: string) {
      // backoff: false — no auto-reconnect; connections only happen when queries are made
      return new NRelay1(url, { backoff: false });
    },

    // Tiered routing for reading (see comment block above)
    reqRouter(filters: NostrFilter[]) {
      const routes = new Map<string, NostrFilter[]>();
      const relaysToQuery = new Set<string>();

      const authors = extractAuthorsFromFilters(filters);
      const userRelays = getUserRelays();

      if (authors.length >= BULK_AUTHOR_THRESHOLD) {
        // Tier 1 — Bulk feed query: skip per-author expansion, use a small fixed set
        userRelays.read.forEach(relay => relaysToQuery.add(relay));
        FALLBACK_RELAYS.forEach(relay => relaysToQuery.add(relay));
        READ_ONLY_RELAYS.forEach(relay => relaysToQuery.add(relay));

        // Hard cap to prevent excessive WebSocket connections
        const capped = Array.from(relaysToQuery).slice(0, MAX_BULK_RELAYS);

        // Batch author lists at 500 per filter to avoid silent relay truncation
        const MAX_AUTHORS_PER_FILTER = 500;
        for (const relay of capped) {
          if (authors.length <= MAX_AUTHORS_PER_FILTER) {
            routes.set(relay, filters);
          } else {
            const batchedFilters: NostrFilter[] = [];
            for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_FILTER) {
              const batch = authors.slice(i, i + MAX_AUTHORS_PER_FILTER);
              for (const filter of filters) {
                if (filter.authors) {
                  batchedFilters.push({ ...filter, authors: batch });
                } else {
                  // Non-author filters (e.g. #p) don't need batching
                  if (i === 0) batchedFilters.push(filter);
                }
              }
            }
            routes.set(relay, batchedFilters);
          }
        }
      } else {
        // Tier 2 — Targeted query: full outbox model
        authors.forEach(author => {
          const authorRelays = getRelayCache(author);
          if (authorRelays.length > 0) {
            authorRelays.slice(0, 3).forEach(relay => relaysToQuery.add(relay));
          }
        });
        userRelays.read.forEach(relay => relaysToQuery.add(relay));
        // Always include fallback + read-only relays — critical for #p queries (notifications)
        // where the user has read relays but the event may live on a fallback relay.
        FALLBACK_RELAYS.forEach(relay => relaysToQuery.add(relay));
        READ_ONLY_RELAYS.forEach(relay => relaysToQuery.add(relay));

        for (const relay of relaysToQuery) {
          routes.set(relay, filters);
        }
      }

      debugLog('reqRouter:', routes.size, 'relays (authors:', authors.length, ')');
      return routes;
    },

    // Smart publishing: user's write relays + author's relays + minimal fallback
    eventRouter(event: NostrEvent) {
      const relaysToPublish = new Set<string>();

      // 1. User's configured write relays (primary - user sovereignty)
      const userRelays = getUserRelays();
      userRelays.write.forEach(relay => relaysToPublish.add(relay));

      // 2. Author's own relays from cache (outbox model)
      const authorRelays = getRelayCache(event.pubkey);
      if (authorRelays.length > 0) {
        authorRelays.slice(0, 3).forEach(relay => relaysToPublish.add(relay));
      }

      // 3. Minimal fallback only if user has no relays configured
      if (relaysToPublish.size === 0) {
        FALLBACK_RELAYS.forEach(relay => relaysToPublish.add(relay));
      }

      debugLog('eventRouter:', relaysToPublish.size, 'relays');
      return Array.from(relaysToPublish);
    },
  });
}

// Initialize cache after IDB is ready (async — pool works with fallback relays until loaded)
idbReady.then(() => loadRelayCache()).catch(() => {});

const NostrProvider: React.FC<NostrProviderProps> = (props) => {
  const { children } = props;

  // Lazy initialization of pool - only created once via useState initializer
  const [pool] = useState<NPool>(() => {
    debugLog('Initializing NPool');
    return createPool();
  });

  // Listen for BroadcastChannel messages from other tabs
  useEffect(() => {
    const channel = getBroadcastChannel();

    const handleMessage = (event: MessageEvent) => {
      // Validate message format before accessing fields
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'relay-cache-entry') {
        const { pubkey, relays } = event.data;
        if (typeof pubkey === 'string' && Array.isArray(relays) && relays.every((r: unknown) => typeof r === 'string')) {
          relayCache.delete(pubkey);
          relayCache.set(pubkey, relays);
        }
      } else if (event.data.type === 'relay-cache-updated') {
        debugLog('Received full relay cache update from another tab');
        loadRelayCache();
      }
    };

    if (channel) {
      channel.addEventListener('message', handleMessage);
    }

    // Flush pending relay cache writes before tab close or background
    const handleFlush = () => {
      if (relayCacheSaveTimer) {
        clearTimeout(relayCacheSaveTimer);
        relayCacheSaveTimer = undefined;
        flushRelayCacheToIdb();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') handleFlush();
    };
    window.addEventListener('beforeunload', handleFlush);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (channel) {
        channel.removeEventListener('message', handleMessage);
        // Do NOT close or null the singleton — other effects/tabs still need it.
      }
      window.removeEventListener('beforeunload', handleFlush);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (relayCacheSaveTimer) {
        clearTimeout(relayCacheSaveTimer);
        relayCacheSaveTimer = undefined;
      }
    };
  }, []);

  const value = useMemo(() => ({ nostr: pool }), [pool]);

  return (
    <NostrContext.Provider value={value}>
      {children}
    </NostrContext.Provider>
  );
};

export default NostrProvider;
