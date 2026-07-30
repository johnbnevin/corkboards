import React, { useState, useEffect, useMemo } from 'react';
import { RELAY_CACHE_TTL_MS } from '@core/cacheConfig';
import { NostrEvent, NostrFilter, NPool, NRelay1 } from '@nostrify/nostrify';
import type { NRelay, NostrRelayEVENT, NostrRelayEOSE, NostrRelayCLOSED } from '@nostrify/nostrify';
import { NostrContext } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { Router, getFilterSelections, addMinimalFallbacks } from '@welshman/router';
import type { TrustedEvent, Filter } from '@welshman/util';
import { recordHit, recordMiss, scoreToWeight, decayScore, type RelayScore } from '@core/router';
import { withQueryBudget, acquireQuerySlot, configureQueryGovernor, defaultMaxConcurrent, lookupPriority } from '@core/queryGovernor';
import { idbGetSync, idbSetSync, idbReady } from '@/lib/idb';
import { isSecureRelay } from '@core/nostrUtils';
import { isTauri, tauriQuery } from '@/lib/tauri';
import { getOrCreateUser } from '@/hooks/useCurrentUser';
// Re-exported for backwards compatibility — canonical source is @/lib/relayConstants
export { FALLBACK_RELAYS, READ_ONLY_RELAYS } from '@/lib/relayConstants';
import { FALLBACK_RELAYS, READ_ONLY_RELAYS } from '@/lib/relayConstants';

interface NostrProviderProps {
  children: React.ReactNode;
}

// Storage keys
const RELAY_CACHE_KEY = 'corkboard:relay-cache';
const APP_CONFIG_KEY = 'corkboard:app-config';

// Debug flag — always on in Tauri (logs go to file, not browser console)
const DEBUG = import.meta.env.DEV || isTauri;

// ============================================================================
// Per-relay rate limiter — max 3 requests per second per relay URL.
// Prevents WebSocket flooding and relay rate-limiting.
// ============================================================================

const MAX_REQUESTS_PER_SECOND = 3;
const RATE_WINDOW_MS = 1000;

// ============================================================================
// Global concurrency ceiling.
//
// Sized from the host's core count because the binding constraint on relay work
// is CPU (TLS handshakes + schnorr verification), not bandwidth. Configured once
// at module load so it is in force before the first query — a provider-mount
// effect would run too late, after the initial feed fan-out has already started.
// ============================================================================
configureQueryGovernor({
  maxConcurrent: defaultMaxConcurrent(
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
  ),
});

/** Tracks timestamps of recent requests per relay URL */
const _relayRequestLog = new Map<string, number[]>();

/**
 * Returns a promise that resolves when the next request to this relay is allowed.
 * Uses a sliding window: max MAX_REQUESTS_PER_SECOND requests within the last RATE_WINDOW_MS.
 */
async function waitForRateLimit(url: string): Promise<void> {
  const key = url.replace(/\/+$/, '');
  let timestamps = _relayRequestLog.get(key);
  if (!timestamps) {
    timestamps = [];
    _relayRequestLog.set(key, timestamps);
  }
  // Loop: after waking, re-check the limit before proceeding. Multiple
  // concurrent waiters can wake at (roughly) the same time — without the
  // re-check they would all record + proceed at once, over-admitting.
  for (;;) {
    const now = Date.now();
    // Prune old entries outside the window
    while (timestamps.length > 0 && timestamps[0] <= now - RATE_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length < MAX_REQUESTS_PER_SECOND) {
      // Under the limit — record and proceed
      timestamps.push(now);
      return;
    }
    // Over the limit — wait until the oldest request expires, then re-check
    const waitMs = timestamps[0] + RATE_WINDOW_MS - now + 1;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

// ============================================================================
// Connection cache + failure backoff for standalone relay calls.
// NPool caches its own relay instances, but hooks that call createRelay()
// directly were creating fresh NRelay1 + WebSocket per call.
// ============================================================================

/**
 * Cached relay instances, keyed by URL **plus a signature of the constructor
 * options**.
 *
 * The options must be part of the key. `createRelayDirect(url, { backoff:
 * false, idleTimeout: false })` is used by the NIP-46 login flows
 * (nostrconnect/Amber), which need a socket that stays open indefinitely
 * waiting for the signer. Keyed on URL alone, that never-idling instance was
 * stored under the bare relay URL — so every later `createRelay(url)` for a
 * FALLBACK_RELAY handed back a connection configured for a completely different
 * purpose, which then never idled out for the rest of the session. Conversely a
 * short-lived default instance could be handed to a login flow that needed it
 * to persist. Same URL, different contracts: different cache entries.
 *
 * Backoff/scoring stay keyed on the bare URL — those are properties of the
 * relay, not of how we opened it.
 */
const _relayCache = new Map<string, { relay: NRelay1; createdAt: number }>();

/**
 * Cache key for a relay instance. Options are serialized in a stable order so
 * `{backoff:false, idleTimeout:false}` and `{idleTimeout:false, backoff:false}`
 * share one entry. `auth` is a function (identity varies per call) so it is
 * deliberately excluded — RateLimitedRelay injects the same shared handler.
 */
function relayCacheKey(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): string {
  const base = url.replace(/\/+$/, '');
  if (!opts) return base;
  const entries = Object.entries(opts as Record<string, unknown>)
    .filter(([k, v]) => k !== 'auth' && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`);
  return entries.length > 0 ? `${base}#${entries.join(',')}` : base;
}

/**
 * Replace a cache entry, CLOSING whatever it displaces.
 *
 * Overwriting a `Map` entry drops the reference to the old NRelay1 but does not
 * close its WebSocket — the socket (and its buffers, and its reconnect timer)
 * survives with nothing left to close it. On a long session, every TTL
 * expiry for every relay leaked one. Closing before we forget is the only place
 * that can still be done.
 */
function setCachedRelay(key: string, relay: NRelay1): void {
  const previous = _relayCache.get(key);
  if (previous && previous.relay !== relay) {
    previous.relay.close().catch(() => {});
  }
  _relayCache.set(key, { relay, createdAt: Date.now() });
}

/** Failure backoff: URL → { failCount, blockedUntil } */
const _relayBackoff = new Map<string, { failCount: number; blockedUntil: number }>();
const BACKOFF_BASE_MS = 5_000;   // 5s after first failure
const BACKOFF_MAX_MS = 120_000;  // cap at 2 minutes

function getBackoffMs(failCount: number): number {
  // Exponential: 5s, 10s, 20s, 40s, 80s, 120s (capped)
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BACKOFF_MAX_MS);
}

// ─── Per-relay quality scoring (welshman router input) ─────────────────────
// hit/miss counters with time-decay, surfaced to welshman's Router via
// getRelayQuality(). Decoupled from the binary "blocked" backoff: a relay
// can be unblocked but still low-quality, in which case selection still
// deprioritizes it.
const _relayScores = new Map<string, RelayScore>();
const SCORE_HALF_LIFE_MS = 60 * 60 * 1000; // 1h

function getRelayWeight(url: string): number {
  const key = url.replace(/\/+$/, '');
  const raw = _relayScores.get(key);
  if (!raw) return 0.5; // unknown → neutral
  const decayed = decayScore(raw, SCORE_HALF_LIFE_MS);
  return scoreToWeight(decayed);
}

/** Record a connection failure for a relay URL.
 *  Only increments once per backoff window — multiple queries failing on the
 *  same broken cached connection don't escalate the backoff. */
function recordRelayFailure(url: string): void {
  const key = url.replace(/\/+$/, '');
  _relayScores.set(key, recordMiss(_relayScores.get(key)));
  const existing = _relayBackoff.get(key);
  // If already in an active backoff window, don't increment — this is just
  // another query failing on the same broken connection.
  if (existing && Date.now() < existing.blockedUntil) return;
  const failCount = (existing?.failCount ?? 0) + 1;
  const backoffMs = getBackoffMs(failCount);
  _relayBackoff.set(key, { failCount, blockedUntil: Date.now() + backoffMs });
  // Evict every cached instance for this relay so the next caller after backoff
  // gets a fresh connection. There can be more than one entry per URL now (the
  // cache keys on constructor options too — see relayCacheKey), and leaving the
  // others behind would keep handing out the broken socket.
  for (const [cacheKey, entry] of _relayCache) {
    if (cacheKey !== key && !cacheKey.startsWith(`${key}#`)) continue;
    entry.relay.close().catch(() => {});
    _relayCache.delete(cacheKey);
  }
}

/** Record a successful operation — clears the backoff and increments score */
function recordRelaySuccess(url: string): void {
  const key = url.replace(/\/+$/, '');
  _relayScores.set(key, recordHit(_relayScores.get(key)));
  _relayBackoff.delete(key);
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
// eslint-disable-next-line react-refresh/only-export-components
export function createRelay(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  // Backoff is a property of the RELAY, so it is looked up by bare URL...
  const backoffKey = url.replace(/\/+$/, '');
  // ...while the instance cache also keys on how the socket was configured.
  const key = relayCacheKey(url, opts);

  // Check backoff — if relay is blocked, return a dummy that rejects immediately
  if (isRelayBlocked(backoffKey)) {
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
    for (const [staleKey, entry] of _relayCache) {
      if (now - entry.createdAt > RELAY_CACHE_TTL_MS) {
        entry.relay.close().catch(() => {});
        _relayCache.delete(staleKey);
      }
    }
  }

  const relay = new RateLimitedRelay(url, opts) as unknown as NRelay1;
  setCachedRelay(key, relay); // closes the expired instance it replaces
  return relay;
}

/**
 * Create a relay that bypasses the failure backoff.
 * Use for critical bootstrap paths (login, backup discovery) where we must
 * try relays even if they failed recently — the user can't proceed without them.
 * Still rate-limited and cached.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function createRelayDirect(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  const key = relayCacheKey(url, opts);
  const cached = _relayCache.get(key);
  if (cached && Date.now() - cached.createdAt < RELAY_CACHE_TTL_MS) return cached.relay;
  const relay = new RateLimitedRelay(url, opts) as unknown as NRelay1;
  setCachedRelay(key, relay); // closes the expired instance it replaces
  return relay;
}

/**
 * Create a fresh relay instance that is NOT stored in the shared cache.
 * Use for one-shot queries where the relay will be closed immediately after use.
 * Closing a cached relay poisons it for subsequent callers; this avoids that.
 * Still rate-limited (same per-URL token bucket as cached relays).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function createRelayFresh(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  return new RateLimitedRelay(url, opts) as unknown as NRelay1;
}

/** Dummy relay returned when a URL is in backoff — fails fast without opening a WebSocket */
class BlockedRelay implements NRelay {
  private url: string;
  constructor(url: string) { this.url = url; }
  // eslint-disable-next-line require-yield
  async *req(): AsyncGenerator<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    throw new Error(`Relay ${this.url} is temporarily blocked (backoff)`);
  }
  async query(): Promise<NostrEvent[]> {
    // Throw (like req/event) so callers can distinguish "relay blocked" from
    // "relay has no data" — they already handle network throws.
    throw new Error(`Relay ${this.url} is temporarily blocked (backoff)`);
  }
  async event(): Promise<void> {
    throw new Error(`Relay ${this.url} is temporarily blocked (backoff)`);
  }
  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

// ─── NIP-42 relay AUTH ──────────────────────────────────────────────────────
// Some relays (paid/private, and the inbox relays NIP-17 DMs increasingly live
// on) gate reads/writes behind an AUTH challenge. Without responding, such a
// relay silently returns nothing. We register the active account's signer here
// and answer challenges with a signed kind-22242 event (NIP-42). The signer is
// set by NostrProvider on login/account-switch; before login it's null and
// challenges simply go unanswered (nothing to authenticate as yet).

interface AuthSigner { signEvent(t: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>; }
let _authSigner: AuthSigner | null = null;

// eslint-disable-next-line react-refresh/only-export-components
export function setRelayAuthSigner(signer: AuthSigner | null): void {
  _authSigner = signer;
}

/** Relays outside the user's configured lists that are still allowed to receive
 *  auto-AUTH — dynamic, deliberate connections (NIP-46 bunker signaling relays,
 *  NWC wallet relays). Registered by the code paths that open them. */
const _authAllowedRelays = new Set<string>();

/** Allow a dynamically discovered relay (bunker/NWC) to receive NIP-42 auto-AUTH. */
// eslint-disable-next-line react-refresh/only-export-components
export function registerAuthRelay(url: string): void {
  _authAllowedRelays.add(url.replace(/\/+$/, ''));
}

/** True when a relay is part of the user's chosen relay set — their configured
 *  NIP-65 read/write relays, their cached own outbox relays, our fallback and
 *  indexer relays, or a dynamically registered relay (bunker/NWC). */
function isAuthAllowedRelay(url: string): boolean {
  const key = url.replace(/\/+$/, '');
  if (_authAllowedRelays.has(key)) return true;
  if (FALLBACK_RELAYS.some(r => normalizeRelayUrl(r) === key)) return true;
  if (READ_ONLY_RELAYS.some(r => normalizeRelayUrl(r) === key)) return true;
  const userRelays = getUserRelays();
  if ([...userRelays.read, ...userRelays.write].some(r => normalizeRelayUrl(r) === key)) return true;
  // The active user's own cached NIP-65 relay list (may predate app config)
  const own = _currentUserPubkeyForRouter ? relayCache.get(_currentUserPubkeyForRouter) : undefined;
  if (own && own.some(r => normalizeRelayUrl(r) === key)) return true;
  return false;
}

async function handleRelayAuthChallenge(relayUrl: string, challenge: string): Promise<NostrEvent> {
  const signer = _authSigner;
  if (!signer) throw new Error('No active signer for NIP-42 relay AUTH');
  // Privacy tradeoff: answering AUTH cryptographically binds the user's pubkey
  // to their IP at that relay. So we only auto-AUTH relays the user has
  // deliberately chosen — their NIP-65/configured relays, our fallback/indexer
  // relays, and dynamically registered relays (NIP-46 bunker signaling, NWC
  // wallet relays). A random fan-out relay reached via outbox routing gets no
  // AUTH: it would gain a proven pubkey↔IP link while contributing little.
  // NOTE: a previous build gated this with a *static* allowlist, which broke
  // NIP-46 login and NWC (their relays are dynamic/per-user) — the
  // registerAuthRelay() escape hatch is what keeps those flows working.
  if (!isAuthAllowedRelay(relayUrl)) {
    throw new Error(`NIP-42 AUTH declined for ${relayUrl} — not in the user's relay set`);
  }
  return signer.signEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', relayUrl], ['challenge', challenge]],
    content: '',
  }) as Promise<NostrEvent>;
}

class RateLimitedRelay implements NRelay {
  private inner: NRelay1;
  private url: string;

  constructor(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]) {
    this.url = url;
    // Inject the default NIP-42 AUTH handler unless the caller supplied one.
    const merged = (opts && opts.auth)
      ? opts
      : { ...opts, auth: (challenge: string) => handleRelayAuthChallenge(url, challenge) };
    this.inner = new NRelay1(url, merged);
  }

  // Both read paths acquire a slot from the GLOBAL query governor before the
  // per-relay rate limiter. Order matters: the rate limiter is per-URL and says
  // nothing about total machine load, so 20 subsystems each querying 8 distinct
  // relays would sail through it while opening 160 concurrent TLS connections.
  // The governor is what bounds that, and it must be entered first so waiting
  // work parks in one queue instead of 8 per-URL ones.
  async *req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    // A generator holds its socket across every yield, so it holds its slot for
    // its whole lifetime — released in `finally` so an early `break` (consumers
    // routinely break on EOSE) still frees it.
    const releaseSlot = await acquireQuerySlot({ priority: lookupPriority(filters) });
    try {
      await waitForRateLimit(this.url);
      // Record success on the first EVENT/EOSE message rather than at generator
      // completion — consumers that `break` on EOSE trigger generator return(),
      // which would skip a post-loop recordRelaySuccess entirely.
      let recorded = false;
      try {
        for await (const msg of this.inner.req(filters, opts)) {
          if (!recorded && (msg[0] === 'EVENT' || msg[0] === 'EOSE')) {
            recorded = true;
            recordRelaySuccess(this.url);
          }
          yield msg;
        }
      } catch (e) {
        recordRelayFailure(this.url);
        throw e;
      }
    } finally {
      releaseSlot();
    }
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    return withQueryBudget(async () => {
      await waitForRateLimit(this.url);
      try {
        const result = await this.inner.query(filters, opts);
        recordRelaySuccess(this.url);
        return result;
      } catch (e) {
        recordRelayFailure(this.url);
        throw e;
      }
    }, { priority: lookupPriority(filters) });
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
const MAX_FEED_RELAYS = 12;       // bulk feed: bounded outbox coverage (was a flat 2; see selectFeedRelays)
const MAX_TARGETED_RELAYS = 3;    // cap for targeted queries (threads, profiles)
// Publishing gets its own, larger budget — see eventRouter. A reply that
// mentions three people needs the user's own write relays PLUS a couple of
// inbox relays per mentioned participant, which a flat 3 cannot express.
const MAX_PUBLISH_RELAYS = 24;    // hard ceiling so a 50-mention note can't fan out unbounded
const PUBLISH_RELAYS_PER_PARTICIPANT = 2;
const MAX_REFERENCE_RELAYS = 8;   // cap for author-less reference queries (thread replies, reactions, comments, notifications)
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

// ─── Welshman Router integration ────────────────────────────────────────────
// `@welshman/router` owns the *selection* logic now — given a pubkey, mode,
// and a quality/limit hint, it picks the right relays. We keep our own
// per-author relayCache, our own backoff/blocklist, and our own 500-author
// batching wrapper around it because those are app-specific concerns
// welshman doesn't (and shouldn't) own.
let _currentUserPubkeyForRouter: string | undefined;
// eslint-disable-next-line react-refresh/only-export-components
export function _setRouterUserPubkey(pubkey: string | undefined): void {
  _currentUserPubkeyForRouter = pubkey;
}
let _routerConfigured = false;
function ensureRouterConfigured(): void {
  if (_routerConfigured) return;
  _routerConfigured = true;
  Router.configure({
    getUserPubkey: () => _currentUserPubkeyForRouter,
    getPubkeyRelays: (pubkey: string, _mode) => {
      // We don't distinguish read/write/messaging per pubkey at the cache layer
      // — outbox NIP-65 lists are the union.
      const cached = relayCache.get(pubkey);
      return (cached ?? []).map(normalizeRelayUrl).filter(u => !isRelayBlocked(u));
    },
    getDefaultRelays: () => [...FALLBACK_RELAYS, ...READ_ONLY_RELAYS].map(normalizeRelayUrl),
    getIndexerRelays: () => FALLBACK_RELAYS.map(normalizeRelayUrl),
    getRelayQuality: (url: string) => isRelayBlocked(url) ? 0 : getRelayWeight(url),
    getLimit: () => MAX_TARGETED_RELAYS,
  });
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
      debugLog(`loadRelayCache: ${relayCache.size} pubkeys cached`);
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

// An "unroutable lookup" is an author-less query the outbox model can't route
// per-pubkey, so welshman only reaches the default relays. Two shapes:
//   - reference tags (#e/#a/#p): thread replies, reactions/comments, notifications
//   - bare id lookups (`ids`): fetching a specific event (thread target, quoted
//     note) whose author we don't know yet — outbox needs an author to route to.
// Both need a wider net (user read relays + fallbacks + indexers) instead of the
// ~3 default relays welshman would otherwise pick.
function hasReferenceTag(filters: NostrFilter[]): boolean {
  return filters.some(f =>
    Object.prototype.hasOwnProperty.call(f, '#e') ||
    Object.prototype.hasOwnProperty.call(f, '#a') ||
    Object.prototype.hasOwnProperty.call(f, '#p') ||
    Object.prototype.hasOwnProperty.call(f, '#t'),  // hashtag feeds — no authors, need wide coverage
  );
}

function hasIdLookup(filters: NostrFilter[]): boolean {
  return filters.some(f => Array.isArray(f.ids) && f.ids.length > 0);
}

// Coverage-ranked relay set for bulk feeds (follows feed + any corkboard with
// many authors). This IS the outbox model, made bounded: instead of opening a
// socket per followed author (900+ on large feeds) or the old flat 2 relays
// (which missed anyone not on those 2), we query the union of
//   - the user's configured read relays,
//   - fallback + archive/indexer relays (cover authors whose NIP-65 list we
//     haven't fetched yet), and
//   - the write relays the followed authors actually publish to, ranked by how
//     many of them each relay covers,
// capped at MAX_FEED_RELAYS. Coverage improves as authors' relay lists load.
function selectFeedRelays(authors: string[]): string[] {
  const selected = new Set<string>();
  const userRelays = getUserRelays();
  // Guaranteed: user reads + fallbacks + indexers (broad safety net).
  userRelays.read.forEach(r => selected.add(normalizeRelayUrl(r)));
  FALLBACK_RELAYS.forEach(r => selected.add(normalizeRelayUrl(r)));
  READ_ONLY_RELAYS.forEach(r => selected.add(normalizeRelayUrl(r)));

  // Rank the authors' own write relays (their outbox) by coverage. Read the
  // cache directly (not getRelayCache) to avoid LRU churn over many authors.
  const coverage = new Map<string, number>();
  for (const author of authors) {
    const relays = relayCache.get(author);
    if (!relays) continue;
    for (const r of relays) {
      const n = normalizeRelayUrl(r);
      if (selected.has(n) || isRelayBlocked(n)) continue;
      coverage.set(n, (coverage.get(n) ?? 0) + 1);
    }
  }
  const ranked = [...coverage.entries()].sort((a, b) => b[1] - a[1]);
  for (const [relay] of ranked) {
    if (selected.size >= MAX_FEED_RELAYS) break;
    selected.add(relay);
  }

  const all = [...selected];
  const healthy = all.filter(r => !isRelayBlocked(r));
  const blocked = all.filter(r => isRelayBlocked(r));
  return [...healthy, ...blocked].slice(0, MAX_FEED_RELAYS);
}

// ─── Outbox Model Relay Routing ──────────────────────────────────────────────
//
// createPool() implements the NIP-65 outbox model with two tiers:
//
//   reqRouter:
//     Tier 1 — Bulk feed queries (authors >= BULK_AUTHOR_THRESHOLD):
//       Bounded outbox model via selectFeedRelays: user read relays + fallbacks
//       + indexers + the authors' own write relays ranked by coverage, capped at
//       MAX_FEED_RELAYS. Covers the followed authors' outboxes without opening a
//       socket per follow (the 900+ risk of naive per-pubkey expansion).
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
  ensureRouterConfigured();
  return new NPool({
    open(url: string) {
      // Rate-limited relay wrapper — max 3 req/sec per relay URL.
      // backoff: false — no auto-reconnect; connections only happen when queries are made.
      return new RateLimitedRelay(url, { backoff: false });
    },

    // Tiered routing for reading.
    //   - Bulk (≥ BULK_AUTHOR_THRESHOLD authors): bounded outbox via
    //     selectFeedRelays (coverage-ranked author write relays + user read +
    //     fallbacks/indexers, capped at MAX_FEED_RELAYS). Batch 500 authors per
    //     filter to avoid relay-side truncation.
    //   - Targeted (< BULK_AUTHOR_THRESHOLD authors, or non-author queries):
    //     hand off to welshman's getFilterSelections so the outbox model is
    //     applied per-pubkey with proper scoring + fallback policy.
    reqRouter(filters: NostrFilter[]) {
      const routes = new Map<string, NostrFilter[]>();
      const authors = extractAuthorsFromFilters(filters);

      if (authors.length >= BULK_AUTHOR_THRESHOLD) {
        // Tier 1 — Bulk feed query (follows feed + large corkboards): apply the
        // outbox model with a bounded, coverage-ranked relay set instead of
        // welshman's per-pubkey expansion (which would open a socket per follow).
        const capped = selectFeedRelays(authors);

        // Batch authors at 500 per filter to avoid silent relay truncation.
        const MAX_AUTHORS_PER_FILTER = 500;
        for (const relay of capped) {
          if (authors.length <= MAX_AUTHORS_PER_FILTER) {
            routes.set(relay, filters);
          } else {
            const batchedFilters: NostrFilter[] = [];
            for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_FILTER) {
              const batch = authors.slice(i, i + MAX_AUTHORS_PER_FILTER);
              for (const filter of filters) {
                if (filter.authors) batchedFilters.push({ ...filter, authors: batch });
                else if (i === 0) batchedFilters.push(filter);
              }
            }
            routes.set(relay, batchedFilters);
          }
        }
      } else if (authors.length === 0 && (hasReferenceTag(filters) || hasIdLookup(filters))) {
        // Tier 2b — Unroutable lookup (thread replies/reactions/comments/
        // notifications via #e/#a/#p, OR a bare `ids` fetch of a specific event
        // like a thread target or quoted note). No authors → per-author outbox
        // routing is impossible, and welshman alone only reaches ~3 default
        // relays (even dropping the archive/indexer relays that are best at
        // finding events by id). That's why a thread target on the author's own
        // relay fails with "couldn't be loaded from your relays". Cast a wide net
        // across the user's configured read relays plus fallbacks/indexers.
        const userRelays = getUserRelays();
        const relaysToQuery = new Set<string>();
        userRelays.read.forEach(r => relaysToQuery.add(normalizeRelayUrl(r)));
        FALLBACK_RELAYS.forEach(r => relaysToQuery.add(normalizeRelayUrl(r)));
        READ_ONLY_RELAYS.forEach(r => relaysToQuery.add(normalizeRelayUrl(r)));
        const all = Array.from(relaysToQuery);
        const healthy = all.filter(r => !isRelayBlocked(r));
        const blocked = all.filter(r => isRelayBlocked(r));
        const capped = [...healthy, ...blocked].slice(0, MAX_REFERENCE_RELAYS);
        for (const relay of capped) routes.set(relay, filters);
      } else {
        // Tier 2 — Targeted query: delegate to welshman's getFilterSelections.
        // It applies the outbox model per-pubkey using the relayCache we expose
        // via Router.configure({ getPubkeyRelays }), then layers in fallbacks
        // according to addMinimalFallbacks (at most 1 default relay when count
        // is low). The result is an array of {relays, filters} selections.
        const selections = getFilterSelections(filters as unknown as Filter[]);
        for (const sel of selections) {
          const cappedRelays = sel.relays.slice(0, MAX_TARGETED_RELAYS).map(normalizeRelayUrl);
          for (const relay of cappedRelays) {
            const existing = routes.get(relay) ?? [];
            // Merge filter lists when welshman points multiple selections at the same relay
            routes.set(relay, [...existing, ...(sel.filters as unknown as NostrFilter[])]);
          }
        }
        // Welshman handles fallbacks via the policy, but for non-author
        // queries (e.g. #p tag for notifications) it can return empty —
        // always include fallback + read-only for resilience.
        if (routes.size === 0) {
          [...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]
            .map(normalizeRelayUrl)
            .slice(0, MAX_TARGETED_RELAYS)
            .forEach(r => routes.set(r, filters));
        }
      }

      if (DEBUG) {
        const relayList = Array.from(routes.keys());
        const tier = authors.length >= BULK_AUTHOR_THRESHOLD
          ? 'T1-bulk'
          : (authors.length === 0 && (hasReferenceTag(filters) || hasIdLookup(filters))) ? 'T2b-reference' : 'T2-welshman';
        const filterDesc = filters.map(f => `kinds=${f.kinds?.join(',')} authors=${f.authors?.length ?? 0} ids=${f.ids?.length ?? 0}`).join(' | ');
        debugLog(`reqRouter [${tier}] authors=${authors.length} → ${routes.size} relays: ${relayList.join(', ')} | filters: ${filterDesc}`);
      }
      return routes;
    },

    // Publishing: delegate to welshman's PublishEvent scenario.
    // It returns the union of the user's write relays + every tagged
    // participant's inbox (read) relays — which is what makes a mention actually
    // ARRIVE for the person mentioned, rather than only existing on relays they
    // never read.
    //
    // The limit was a flat MAX_TARGETED_RELAYS (3), shared with the query path.
    // Three slots cannot hold "my write relays AND your inbox relays": the
    // user's own 3-4 write relays alone consumed the whole budget, so every
    // mentioned user's inbox relays were truncated away and the notification
    // simply never reached them — invisible, because the publish still succeeded
    // on our own relays. Budget it by what the event actually needs: our write
    // relays plus a couple per tagged participant, under a hard ceiling so a
    // note tagging fifty people can't fan out unbounded. (M9b)
    eventRouter(event: NostrEvent) {
      const participants = new Set(
        event.tags.filter(t => t[0] === 'p' && typeof t[1] === 'string' && t[1]).map(t => t[1]),
      );
      const ownWriteCount = getUserRelays().write.length || FALLBACK_RELAYS.length;
      const budget = Math.min(
        MAX_PUBLISH_RELAYS,
        Math.max(
          MAX_TARGETED_RELAYS,
          ownWriteCount + participants.size * PUBLISH_RELAYS_PER_PARTICIPANT,
        ),
      );

      const scenario = Router.get()
        .PublishEvent(event as unknown as TrustedEvent)
        .policy(addMinimalFallbacks)
        .limit(budget);
      const urls = scenario.getUrls().map(normalizeRelayUrl);

      // Author's own cached outbox relays — welshman includes them already,
      // but guarantee at least 1 fallback if everything else is empty.
      if (urls.length === 0) {
        const fb = FALLBACK_RELAYS.map(normalizeRelayUrl);
        if (DEBUG) debugLog(`eventRouter: no relays from welshman, using fallbacks → ${fb.length}`);
        return fb.slice(0, MAX_TARGETED_RELAYS);
      }

      if (DEBUG) debugLog(`eventRouter: kind=${event.kind} → ${urls.length} relays: ${urls.join(', ')}`);
      return urls;
    },
  });
}

// Initialize cache after IDB is ready (async — pool works with fallback relays until loaded)
idbReady.then(() => loadRelayCache()).catch(() => {});

// ── Tauri relay routing ───────────────────────────────────────────────────────
// In Tauri, queries go through the Rust pool_query bridge — but they still need
// a relay list. We delegate to welshman's getFilterSelections for the targeted
// tier (so it benefits from per-relay scoring and outbox routing), and keep the
// manual bulk path for high-author queries to cap WS fan-out on desktop.
function getTauriRelaysForFilter(filter: Record<string, unknown>): string[] {
  ensureRouterConfigured();
  const authors = (filter.authors as string[] | undefined) ?? [];
  const relaySet = new Set<string>();

  if (authors.length >= BULK_AUTHOR_THRESHOLD) {
    // T1-bulk: find most-used relays across sampled authors (same as before).
    const freq = new Map<string, number>();
    for (const pk of authors.slice(0, 100)) {
      for (const r of getRelayCache(pk).slice(0, 3)) {
        if (isSecureRelay(r)) freq.set(r, (freq.get(r) ?? 0) + 1);
      }
    }
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .forEach(([r]) => relaySet.add(r));
  } else if (authors.length > 0) {
    // T2-targeted: delegate to welshman so the relay selection benefits from
    // per-pubkey outbox + per-relay scoring instead of just-cached-relays.
    try {
      const selections = getFilterSelections([filter as unknown as Filter]);
      for (const sel of selections) {
        for (const r of sel.relays) {
          if (isSecureRelay(r)) relaySet.add(normalizeRelayUrl(r));
        }
      }
    } catch {
      // Welshman can throw if its singleton hasn't been configured; fall through
      // to fallbacks below.
    }
  }

  // Always include fallbacks and read-only relays (deduplicated via Set)
  FALLBACK_RELAYS.forEach(r => relaySet.add(normalizeRelayUrl(r)));
  READ_ONLY_RELAYS.forEach(r => relaySet.add(normalizeRelayUrl(r)));

  // Deprioritise relays in failure backoff. The web path has always done this
  // (createRelay returns a BlockedRelay that fails without opening a socket);
  // desktop did not, so a dead relay kept costing a full DNS + TCP + TLS
  // handshake on every single query, forever. Keep blocked relays as a tail
  // rather than dropping them, so a transient outage can't empty the list.
  const all = Array.from(relaySet);
  const healthy = all.filter(r => !isRelayBlocked(r));
  const blocked = all.filter(r => isRelayBlocked(r));
  return [...healthy, ...blocked].slice(0, 8);
}

const NostrProvider: React.FC<NostrProviderProps> = (props) => {
  const { children } = props;

  // Lazy initialization of pool - only created once via useState initializer
  const [pool] = useState<NPool>(() => {
    debugLog('Initializing NPool');
    return createPool();
  });

  // Keep welshman's Router in sync with the active login so its outbox
  // scenarios know who "the user" is. NostrLoginProvider wraps NostrProvider,
  // so this hook is always available here.
  const { logins } = useNostrLogin();
  useEffect(() => {
    const activeLogin = logins[0];
    _setRouterUserPubkey(activeLogin?.pubkey);
    // Register the active account's signer for NIP-42 relay AUTH challenges
    // (reuses the cached NUser so bunker logins don't spawn a second signer).
    if (activeLogin) {
      // NIP-46 bunker signaling relays are dynamic (per-user) — register them
      // so the gated auto-AUTH handler will answer their challenges.
      if (activeLogin.type === 'bunker') {
        for (const r of activeLogin.data.relays) registerAuthRelay(r);
      }
      try {
        setRelayAuthSigner(getOrCreateUser(activeLogin, pool).signer as AuthSigner);
      } catch {
        setRelayAuthSigner(null);
      }
    } else {
      setRelayAuthSigner(null);
    }
  }, [logins, pool]);

  // Listen for BroadcastChannel messages from other tabs
  useEffect(() => {
    const channel = getBroadcastChannel();

    const handleMessage = (event: MessageEvent) => {
      // Validate message format before accessing fields
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'relay-cache-entry') {
        const { pubkey, relays } = event.data;
        if (typeof pubkey === 'string' && Array.isArray(relays)) {
          // Apply the SAME isSecureRelay gate the other two write paths use
          // (updateRelayCache and loadRelayCache). Without it this was the one
          // way into the relay cache that accepted `ws://` or a private/LAN
          // address — a stale tab running an older build, or any same-origin
          // script, could seed relays we'd then query with the user's follow
          // graph. Drop the message entirely if nothing survives, rather than
          // caching an empty list that would shadow a good one.
          const secure = (relays as unknown[]).filter(
            (r): r is string => typeof r === 'string' && isSecureRelay(r),
          );
          if (secure.length > 0) {
            relayCache.delete(pubkey);
            relayCache.set(pubkey, secure);
          }
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
      // Flush (not drop) any pending debounced write so cache updates
      // accumulated in the last 2s aren't lost on unmount.
      handleFlush();
    };
  }, []);

  const value = useMemo(() => {
    if (!isTauri) return { nostr: pool };

    // ── Desktop: every read goes through the native Rust socket bridge ───────
    //
    // WebKitGTK's WebSocket implementation is the documented crash path on
    // Linux under connection pressure, which is why `query()` was routed
    // through Rust in the first place. But `relay()` and `group()` were left
    // pointing at the pool, so they still opened WebKitGTK sockets — and those
    // are not rare paths:
    //
    //   useAuthor      nostr.relay(url).query(...) x4 per uncached profile
    //   useNip65Relays nostr.relay(url).query(...)
    //   useBookmarks   nostr.relay(url)
    //   useCustomFeed  nostr.group(feed.relays)
    //
    // A screenful of notes with uncached authors therefore opened ~4 WebKitGTK
    // sockets per author, concurrently, on exactly the code path the bridge
    // exists to avoid. Route them through the bridge too, so the desktop build
    // has ONE socket implementation rather than two.
    const runNativeQuery = async (
      filters: unknown[],
      opts: { signal?: AbortSignal } | undefined,
      relaysFor: (filter: Record<string, unknown>) => string[],
    ): Promise<NostrEvent[]> => {
      // The Rust relay_subscribe command takes a single filter — run one
      // query per filter and merge, so multi-filter callers aren't
      // silently truncated to filters[0].
      const list = (filters.length > 0 ? filters : [{}]) as Record<string, unknown>[];
      const queries = Promise.all(
        list.map(filter =>
          // Governed: desktop previously bypassed BOTH the per-relay rate
          // limiter and any global ceiling, so an unbounded number of
          // relay_subscribe invocations could be in flight, each spawning a
          // tokio task (and a fresh TLS handshake) per relay.
          withQueryBudget(() => {
            const relays = relaysFor(filter);
            // The signal goes INTO tauriQuery rather than racing the promise.
            // Racing it rejected the whole query on abort, discarding every
            // event Rust had already returned — and since callers pass
            // `AbortSignal.timeout(5000)` against this same 5000 ms budget, the
            // two expired together and the abort usually won. That is what made
            // "load 25/100 more" do nothing on desktop while working on web.
            // Aborting now ends the read and keeps the partial page, which is
            // exactly what NRelay1 does on web and what relay.rs does natively.
            return tauriQuery(relays, filter, 5000, opts?.signal) as Promise<NostrEvent[]>;
          }, { priority: lookupPriority([filter]) }),
        ),
      );
      const results = await queries;
      // Merge + dedup by event id across per-filter result sets
      const seen = new Set<string>();
      const merged: NostrEvent[] = [];
      for (const events of results) {
        for (const e of events) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            merged.push(e);
          }
        }
      }
      return merged;
    };

    /**
     * Route `query()` through the native bridge while leaving everything else
     * — crucially `req()` — on the real pool relay.
     *
     * This MUST wrap the real relay rather than replace it. An earlier version
     * returned a hand-rolled object with only `query`/`close`, which silently
     * removed `req()` from every `nostr.relay()` / `nostr.group()` caller. That
     * broke NIP-46 (bunker) signing outright: NConnectSigner keeps a live
     * kind-24133 subscription open on `pool.group(...)` to receive the remote
     * signer's replies, so every sign and every NIP-44 decrypt failed with
     * "this.relay.req is not a function" — taking bookmarks and the backup
     * restore flow down with them.
     *
     * `req()` therefore stays on the pool's own socket. That is deliberate, not
     * an oversight: the native bridge is one-shot (REQ → EOSE → close), and a
     * NIP-46 subscription must stay open to hear the response. It is also not a
     * load concern — it's a handful of long-lived subscriptions, not the
     * per-profile query storm the bridge exists to keep off WebKitGTK.
     */
    const nativeRelayShim = (urls: string[]) => {
      const healthy = urls.map(normalizeRelayUrl).filter(u => !isRelayBlocked(u));
      // All candidates in backoff: still try them rather than returning nothing —
      // a hard empty would surface as "profile not found" for the whole session.
      const targets = healthy.length > 0 ? healthy : urls.map(normalizeRelayUrl);
      // Call through `pool` (the raw NPool), not the proxy, or this recurses.
      const underlying = urls.length === 1 ? pool.relay(urls[0]) : pool.group(urls);
      return new Proxy(underlying, {
        get(t, prop) {
          if (prop === 'query') {
            return (filters: unknown[], opts?: { signal?: AbortSignal }) =>
              runNativeQuery(filters, opts, () => targets);
          }
          // Read with the TARGET as receiver, not the proxy: NRelay1 uses private
          // `#fields`, and those are keyed to the real instance. Forwarding the
          // proxy as receiver makes any getter that touches one throw
          // "Cannot read private member from an object whose class did not
          // declare it". Same reason methods are bound below.
          const value = Reflect.get(t, prop);
          return typeof value === 'function' ? value.bind(t) : value;
        },
      });
    };

    const tauriProxy = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (filters: unknown[], opts?: { signal?: AbortSignal }) =>
            runNativeQuery(filters, opts, getTauriRelaysForFilter);
        }
        if (prop === 'relay') {
          return (url: string) => nativeRelayShim([url]);
        }
        if (prop === 'group') {
          return (urls: string[]) => nativeRelayShim(urls);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { nostr: tauriProxy as NPool };
  }, [pool]);

  return (
    <NostrContext.Provider value={value}>
      {children}
    </NostrContext.Provider>
  );
};

export default NostrProvider;
