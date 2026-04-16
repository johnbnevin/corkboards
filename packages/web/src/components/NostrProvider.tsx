import React, { useState, useEffect, useMemo } from 'react';
import { NostrEvent, NostrFilter, NPool, NRelay1 } from '@nostrify/nostrify';
import type { NRelay, NostrRelayEVENT, NostrRelayEOSE, NostrRelayCLOSED } from '@nostrify/nostrify';
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
// Per-relay rate limiter — max 3 requests per second per relay URL.
// Prevents WebSocket flooding and relay rate-limiting.
// ============================================================================

const MAX_REQUESTS_PER_SECOND = 3;
const RATE_WINDOW_MS = 1000;

/** Tracks timestamps of recent requests per relay URL */
const _relayRequestLog = new Map<string, number[]>();

/**
 * Returns a promise that resolves when the next request to this relay is allowed.
 * Uses a sliding window: max MAX_REQUESTS_PER_SECOND requests within the last RATE_WINDOW_MS.
 */
function waitForRateLimit(url: string): Promise<void> {
  const now = Date.now();
  const key = url.replace(/\/+$/, '');
  let timestamps = _relayRequestLog.get(key);
  if (!timestamps) {
    timestamps = [];
    _relayRequestLog.set(key, timestamps);
  }
  // Prune old entries outside the window
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length < MAX_REQUESTS_PER_SECOND) {
    // Under the limit — proceed immediately
    timestamps.push(now);
    return Promise.resolve();
  }
  // Over the limit — wait until the oldest request expires
  const waitMs = timestamps[0] + RATE_WINDOW_MS - now + 1;
  return new Promise(resolve => setTimeout(() => {
    // Re-prune and record after waiting
    const ts = _relayRequestLog.get(key)!;
    const n = Date.now();
    while (ts.length > 0 && ts[0] <= n - RATE_WINDOW_MS) ts.shift();
    ts.push(n);
    resolve();
  }, waitMs));
}

// ============================================================================
// Connection cache + failure backoff for standalone relay calls.
// NPool caches its own relay instances, but hooks that call createRelay()
// directly were creating fresh NRelay1 + WebSocket per call.
// ============================================================================

/** Cached relay instances by URL — reused across all createRelay() calls */
const _relayCache = new Map<string, { relay: NRelay1; createdAt: number }>();
/** Max age before a cached relay is evicted (connections go stale) */
const RELAY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Failure backoff: URL → { failCount, blockedUntil } */
const _relayBackoff = new Map<string, { failCount: number; blockedUntil: number }>();
const BACKOFF_BASE_MS = 5_000;   // 5s after first failure
const BACKOFF_MAX_MS = 120_000;  // cap at 2 minutes

function getBackoffMs(failCount: number): number {
  // Exponential: 5s, 10s, 20s, 40s, 80s, 120s (capped)
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BACKOFF_MAX_MS);
}

/** Record a connection failure for a relay URL.
 *  Only increments once per backoff window — multiple queries failing on the
 *  same broken cached connection don't escalate the backoff. */
function recordRelayFailure(url: string): void {
  const key = url.replace(/\/+$/, '');
  const existing = _relayBackoff.get(key);
  // If already in an active backoff window, don't increment — this is just
  // another query failing on the same broken connection.
  if (existing && Date.now() < existing.blockedUntil) return;
  const failCount = (existing?.failCount ?? 0) + 1;
  const backoffMs = getBackoffMs(failCount);
  _relayBackoff.set(key, { failCount, blockedUntil: Date.now() + backoffMs });
  // Evict the cached relay so the next caller after backoff gets a fresh connection
  _relayCache.delete(key);
}

/** Record a successful operation — clears the backoff */
function recordRelaySuccess(url: string): void {
  _relayBackoff.delete(url.replace(/\/+$/, ''));
}

/** Check if a relay is currently in backoff (should not be contacted) */
function isRelayBlocked(url: string): boolean {
  const entry = _relayBackoff.get(url.replace(/\/+$/, ''));
  if (!entry) return false;
  if (Date.now() >= entry.blockedUntil) return false; // backoff expired
  return true;
}

/**
 * Create a rate-limited, cached relay. Use this instead of `new NRelay1(url)`.
 * - Reuses existing connections (5-minute TTL)
 * - Respects failure backoff (exponential, up to 2 minutes)
 * - Rate-limits queries to 3/sec per relay
 */
/**
 * Create a rate-limited, cached relay.
 * Use `createRelayDirect()` for critical bootstrap paths (login, backup discovery)
 * that must bypass the failure backoff.
 */
export function createRelay(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  // Normalize URL for cache/backoff lookups (trailing slash differences)
  const key = url.replace(/\/+$/, '');

  // Check backoff — if relay is blocked, return a dummy that rejects immediately
  if (isRelayBlocked(key)) {
    return new BlockedRelay(url) as unknown as NRelay1;
  }

  // Check cache
  const cached = _relayCache.get(key);
  if (cached && Date.now() - cached.createdAt < RELAY_CACHE_TTL_MS) {
    return cached.relay;
  }

  // Evict stale entries periodically
  if (_relayCache.size > 50) {
    const now = Date.now();
    for (const [key, entry] of _relayCache) {
      if (now - entry.createdAt > RELAY_CACHE_TTL_MS) _relayCache.delete(key);
    }
  }

  const relay = new RateLimitedRelay(url, opts) as unknown as NRelay1;
  _relayCache.set(key, { relay, createdAt: Date.now() });
  return relay;
}

/**
 * Create a relay that bypasses the failure backoff.
 * Use for critical bootstrap paths (login, backup discovery) where we must
 * try relays even if they failed recently — the user can't proceed without them.
 * Still rate-limited and cached.
 */
export function createRelayDirect(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  const key = url.replace(/\/+$/, '');
  const cached = _relayCache.get(key);
  if (cached && Date.now() - cached.createdAt < RELAY_CACHE_TTL_MS) return cached.relay;
  const relay = new RateLimitedRelay(url, opts) as unknown as NRelay1;
  _relayCache.set(key, { relay, createdAt: Date.now() });
  return relay;
}

/** Dummy relay returned when a URL is in backoff — fails fast without opening a WebSocket */
class BlockedRelay implements NRelay {
  private url: string;
  constructor(url: string) { this.url = url; }
  async *req(): AsyncGenerator<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    throw new Error(`Relay ${this.url} is temporarily blocked (backoff)`);
  }
  async query(): Promise<NostrEvent[]> { return []; }
  async event(): Promise<void> {
    throw new Error(`Relay ${this.url} is temporarily blocked (backoff)`);
  }
  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

class RateLimitedRelay implements NRelay {
  private inner: NRelay1;
  private url: string;

  constructor(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]) {
    this.url = url;
    this.inner = new NRelay1(url, opts);
  }

  async *req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    await waitForRateLimit(this.url);
    try {
      yield* this.inner.req(filters, opts);
      recordRelaySuccess(this.url);
    } catch (e) {
      recordRelayFailure(this.url);
      throw e;
    }
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    await waitForRateLimit(this.url);
    try {
      const result = await this.inner.query(filters, opts);
      recordRelaySuccess(this.url);
      return result;
    } catch (e) {
      recordRelayFailure(this.url);
      throw e;
    }
  }

  async event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    await waitForRateLimit(this.url);
    try {
      await this.inner.event(event, opts);
      recordRelaySuccess(this.url);
    } catch (e) {
      recordRelayFailure(this.url);
      throw e;
    }
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

// ============================================================================
// Relay Cache with BroadcastChannel for cross-tab sync
// ============================================================================

// Map of pubkey -> array of relay URLs (LRU-evicted at MAX_RELAY_CACHE entries)
const MAX_RELAY_CACHE = 5000;

// Tiered relay routing thresholds (see reqRouter below)
const BULK_AUTHOR_THRESHOLD = 10; // >= this many authors → bulk tier (no per-author expansion)
const MAX_BULK_RELAYS = 2;        // query only 2 relays at a time; expand if results disagree
const MAX_TARGETED_RELAYS = 3;    // cap for targeted queries (threads, profiles)
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

/** Normalize a relay URL for deduplication — strips trailing slashes */
function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, '');
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
      // Rate-limited relay wrapper — max 3 req/sec per relay URL.
      // backoff: false — no auto-reconnect; connections only happen when queries are made.
      return new RateLimitedRelay(url, { backoff: false });
    },

    // Tiered routing for reading (see comment block above)
    reqRouter(filters: NostrFilter[]) {
      const routes = new Map<string, NostrFilter[]>();
      const relaysToQuery = new Set<string>();

      const authors = extractAuthorsFromFilters(filters);
      const userRelays = getUserRelays();

      if (authors.length >= BULK_AUTHOR_THRESHOLD) {
        // Tier 1 — Bulk feed query: skip per-author expansion, use a small fixed set
        userRelays.read.forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));
        FALLBACK_RELAYS.forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));
        READ_ONLY_RELAYS.forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));

        // Prefer relays not in backoff; pick 2 healthy ones first
        const all = Array.from(relaysToQuery);
        const healthy = all.filter(r => !isRelayBlocked(r));
        const blocked = all.filter(r => isRelayBlocked(r));
        const capped = [...healthy, ...blocked].slice(0, MAX_BULK_RELAYS);

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
            authorRelays.slice(0, 3).forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));
          }
        });
        userRelays.read.forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));
        // Always include fallback + read-only relays — critical for #p queries (notifications)
        // where the user has read relays but the event may live on a fallback relay.
        FALLBACK_RELAYS.forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));
        READ_ONLY_RELAYS.forEach(relay => relaysToQuery.add(normalizeRelayUrl(relay)));

        // Prefer healthy relays, cap to MAX_TARGETED_RELAYS
        const allTargeted = Array.from(relaysToQuery);
        const healthyTargeted = allTargeted.filter(r => !isRelayBlocked(r));
        const blockedTargeted = allTargeted.filter(r => isRelayBlocked(r));
        const cappedTargeted = [...healthyTargeted, ...blockedTargeted].slice(0, MAX_TARGETED_RELAYS);
        for (const relay of cappedTargeted) {
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
      userRelays.write.forEach(relay => relaysToPublish.add(normalizeRelayUrl(relay)));

      // 2. Author's own relays from cache (outbox model)
      const authorRelays = getRelayCache(event.pubkey);
      if (authorRelays.length > 0) {
        authorRelays.slice(0, 3).forEach(relay => relaysToPublish.add(normalizeRelayUrl(relay)));
      }

      // 3. Minimal fallback only if user has no relays configured
      if (relaysToPublish.size === 0) {
        FALLBACK_RELAYS.forEach(relay => relaysToPublish.add(normalizeRelayUrl(relay)));
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
