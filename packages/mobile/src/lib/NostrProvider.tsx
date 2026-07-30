/**
 * Mobile NostrProvider — NPool with outbox model routing.
 * Adapted from the web version; uses MMKV instead of IDB,
 * no BroadcastChannel (single-process mobile environment).
 */
import React, { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { NPool, NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent, NostrFilter, NPool as NPoolType } from '@nostrify/nostrify';
import { Router, getFilterSelections, addMinimalFallbacks } from '@welshman/router';
import type { TrustedEvent, Filter } from '@welshman/util';
import { mobileStorage } from '../storage/MmkvStorage';
import { isSecureRelay } from '@core/nostrUtils';
import { RELAY_CACHE_TTL_MS } from '@core/cacheConfig';
import { recordHit, recordMiss, scoreToWeight, decayScore, type RelayScore } from '@core/router';
import { withQueryBudget, configureQueryGovernor, defaultMaxConcurrent, lookupPriority } from '@core/queryGovernor';
import { getSessionSignal } from '../hooks/useSessionAbort';
import { FALLBACK_RELAYS, READ_ONLY_RELAYS, ZAP_RELAYS } from '@core/relayConstants';
import { useAuth } from './AuthContext';
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
const MAX_FEED_RELAYS = 12;       // bulk feed: bounded outbox coverage (see selectFeedRelays)
const MAX_TARGETED_RELAYS = 3;
const MAX_REFERENCE_RELAYS = 8;   // cap for author-less reference queries (thread replies, reactions, comments, notifications)
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

  // Eviction policy is "most-recently-written, drop oldest write" (MRW + FIFO
  // on write). Each `updateRelayCache` deletes the existing entry then re-inserts
  // so the rewritten entry moves to the end of the Map's insertion order; the
  // loop below evicts from the front (oldest writes). Pure reads via
  // getRelayCache() do NOT refresh — so this is not full LRU. That's intentional
  // for relay routing: an entry's freshness matters more than its read frequency.
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
/** Normalize a relay URL for deduplication — strips trailing slashes.
 *  Mirrors web's normalizeRelayUrl() so both platforms compare relay identity
 *  the same way (`wss://a.example` and `wss://a.example/` are one relay).
 *
 *  NOT `@core/normalizeRelay`: that one canonicalizes to `wss://host/` WITH a
 *  trailing slash and rewrites `ws://`/`http(s)://` schemes. It is the right
 *  function for *storing* a relay the user typed; this one is a comparison key
 *  and produces the opposite slash convention, so the two are not
 *  interchangeable. Swapping it would silently change every AUTH-allowlist key
 *  in this module at once. Left as-is on purpose. */
function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

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
// Per-relay rate limiter — max 3 requests per second per relay URL
// ============================================================================

const MAX_REQUESTS_PER_SECOND = 3;
const RATE_WINDOW_MS = 1000;
const _relayRequestLog = new Map<string, number[]>();

// ============================================================================
// Global concurrency ceiling (parity with web NostrProvider).
//
// Sized from core count because the binding constraint on relay work is CPU
// (TLS handshakes + signature verification), not bandwidth. Phones are the
// tightest case of all, so the low-end floor matters most here. Configured at
// module load so it is in force before the first query.
// ============================================================================
configureQueryGovernor({
  maxConcurrent: defaultMaxConcurrent(
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency
      : undefined,
  ),
});

function waitForRateLimit(url: string): Promise<void> {
  const now = Date.now();
  let timestamps = _relayRequestLog.get(url);
  if (!timestamps) { timestamps = []; _relayRequestLog.set(url, timestamps); }
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_WINDOW_MS) timestamps.shift();
  if (timestamps.length < MAX_REQUESTS_PER_SECOND) {
    timestamps.push(now);
    return Promise.resolve();
  }
  const waitMs = timestamps[0] + RATE_WINDOW_MS - now + 1;
  return new Promise(resolve => setTimeout(() => {
    const ts = _relayRequestLog.get(url)!;
    const n = Date.now();
    while (ts.length > 0 && ts[0] <= n - RATE_WINDOW_MS) ts.shift();
    ts.push(n);
    resolve();
  }, waitMs));
}

// ── Connection cache + failure backoff ───────────────────────────────────

const _relayCache = new Map<string, { relay: NRelay1; createdAt: number }>();
const _relayBackoff = new Map<string, { failCount: number; blockedUntil: number }>();
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;

function getBackoffMs(failCount: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BACKOFF_MAX_MS);
}

// Per-relay quality scoring (parity with web's router integration). Backoff is
// a binary "blocked" gate; scoring is a continuous weight surfaced to Router so
// a relay that's unblocked but still flaky gets deprioritised in selection.
const _relayScores = new Map<string, RelayScore>();
const SCORE_HALF_LIFE_MS = 60 * 60 * 1000;

function getRelayWeight(url: string): number {
  const raw = _relayScores.get(url);
  if (!raw) return 0.5;
  return scoreToWeight(decayScore(raw, SCORE_HALF_LIFE_MS));
}

function recordRelayFailure(url: string): void {
  _relayScores.set(url, recordMiss(_relayScores.get(url)));
  const existing = _relayBackoff.get(url);
  if (existing && Date.now() < existing.blockedUntil) return;
  const failCount = (existing?.failCount ?? 0) + 1;
  _relayBackoff.set(url, { failCount, blockedUntil: Date.now() + getBackoffMs(failCount) });
  _relayCache.delete(url);
}
function recordRelaySuccess(url: string): void {
  _relayScores.set(url, recordHit(_relayScores.get(url)));
  _relayBackoff.delete(url);
}
function isRelayBlocked(url: string): boolean {
  const entry = _relayBackoff.get(url);
  return !!entry && Date.now() < entry.blockedUntil;
}

/**
 * Relay returned while a URL is in failure backoff — fails fast without opening
 * a WebSocket.
 *
 * Parity with web's `BlockedRelay` class, in two ways that both mattered:
 *
 *   - It THROWS rather than resolving to `[]`. Returning an empty array is
 *     indistinguishable from "this relay genuinely has no matching events", so
 *     callers that race several relays and fall back on failure (fetchEvent's
 *     two-phase outbox lookup) treated a blocked relay as an authoritative
 *     "not found" and gave up early. Callers already handle network throws.
 *   - It stubs `req` too. The previous version only replaced `query`/`event` on
 *     a real NRelay1, so `relay.req(...)` — the path fetchEvent, useRelayFeed,
 *     useNwc and OnboardSearchWidget all use — still opened a socket to the very
 *     relay we had just decided to stop contacting.
 */
class BlockedRelay {
  constructor(private url: string) {}
  private fail(): never {
    throw new Error(`Relay ${this.url} is temporarily blocked (backoff)`);
  }
  // eslint-disable-next-line require-yield
  async *req(): AsyncGenerator<never> { this.fail(); }
  async query(): Promise<NostrEvent[]> { this.fail(); }
  async event(): Promise<void> { this.fail(); }
  async close(): Promise<void> { /* nothing was opened */ }
  async [Symbol.asyncDispose](): Promise<void> { /* nothing was opened */ }
}

// ─── NIP-42 relay AUTH ──────────────────────────────────────────────────────
// Parity with web's NostrProvider: answer relay AUTH challenges with a signed
// kind-22242 event so paid/private relays (and the inbox relays NIP-17 DMs live
// on) don't silently return nothing. Signer is registered by WelshmanRouterBridge
// on login/account-switch; null before login.
interface AuthSigner { signEvent(t: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>; }
let _authSigner: AuthSigner | null = null;

export function setRelayAuthSigner(signer: AuthSigner | null): void {
  _authSigner = signer;
}

/** Relays outside the user's configured lists that are still allowed to receive
 *  auto-AUTH — dynamic, deliberate connections (NIP-46 bunker signaling relays,
 *  NWC wallet relays). Registered by the code paths that open them. */
const _authAllowedRelays = new Set<string>();

/** Allow a dynamically discovered relay (bunker/NWC) to receive NIP-42 auto-AUTH. */
export function registerAuthRelay(url: string): void {
  _authAllowedRelays.add(normalizeRelayUrl(url));
}

/** True when a relay is part of the user's chosen relay set — their configured
 *  NIP-65 read/write relays, their cached own outbox relays, our fallback and
 *  indexer relays, or a dynamically registered relay (bunker/NWC). */
function isAuthAllowedRelay(url: string): boolean {
  const key = normalizeRelayUrl(url);
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
  // Privacy tradeoff (parity with web): answering AUTH cryptographically binds
  // the user's pubkey to their IP at that relay. So we only auto-AUTH relays the
  // user deliberately chose — their NIP-65/configured relays, our fallback and
  // indexer relays, and dynamically registered relays (NIP-46 bunker signaling,
  // NWC wallet relays). A random fan-out relay reached through outbox routing
  // gets no AUTH: it would gain a proven pubkey↔IP link while contributing
  // little. Mobile previously answered EVERY challenge, which de-anonymized the
  // user at any relay the router happened to reach.
  //
  // An earlier attempt at this used a STATIC allowlist and broke NIP-46 login
  // and NWC (their relays are dynamic/per-user) — the registerAuthRelay()
  // escape hatch above is what keeps those flows working.
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

/** Merge the default NIP-42 AUTH handler into relay opts unless one is supplied. */
function withAuth(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): ConstructorParameters<typeof NRelay1>[1] {
  if (opts && opts.auth) return opts;
  return { ...opts, auth: (challenge: string) => handleRelayAuthChallenge(url, challenge) };
}

/**
 * Create a rate-limited, cached relay with failure backoff.
 */
export function createRelay(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  if (isRelayBlocked(url)) {
    return new BlockedRelay(url) as unknown as NRelay1;
  }

  const cached = _relayCache.get(url);
  if (cached && Date.now() - cached.createdAt < RELAY_CACHE_TTL_MS) return cached.relay;

  if (_relayCache.size > 50) {
    const now = Date.now();
    for (const [key, entry] of _relayCache) {
      if (now - entry.createdAt > RELAY_CACHE_TTL_MS) _relayCache.delete(key);
    }
  }

  const inner = new NRelay1(url, withAuth(url, opts));
  const origQuery = inner.query.bind(inner);
  const origEvent = inner.event.bind(inner);
  // Global ceiling first, per-URL rate limit second. The rate limiter is
  // per-relay and says nothing about total load, so many subsystems each
  // querying distinct relays sail through it while the device opens dozens of
  // concurrent TLS connections. The governor is what bounds that.
  inner.query = async (filters, qOpts) => withQueryBudget(async () => {
    await waitForRateLimit(url);
    try { const r = await origQuery(filters, qOpts); recordRelaySuccess(url); return r; }
    catch (e) { recordRelayFailure(url); throw e; }
  }, { priority: lookupPriority(filters) });
  inner.event = async (event, eOpts) => {
    await waitForRateLimit(url);
    try { await origEvent(event, eOpts); recordRelaySuccess(url); }
    catch (e) { recordRelayFailure(url); throw e; }
  };
  _relayCache.set(url, { relay: inner, createdAt: Date.now() });
  return inner;
}

/**
 * Create a fresh relay instance that is NOT stored in the shared cache.
 * Use for one-shot queries where the relay will be closed immediately after use.
 * Closing a cached relay poisons it for subsequent callers; this avoids that.
 * Still rate-limited (same per-URL token bucket as cached relays).
 */
export function createRelayFresh(url: string, opts?: ConstructorParameters<typeof NRelay1>[1]): NRelay1 {
  const inner = new NRelay1(url, withAuth(url, opts));
  const origQuery = inner.query.bind(inner);
  const origEvent = inner.event.bind(inner);
  // Global ceiling first, per-URL rate limit second. The rate limiter is
  // per-relay and says nothing about total load, so many subsystems each
  // querying distinct relays sail through it while the device opens dozens of
  // concurrent TLS connections. The governor is what bounds that.
  inner.query = async (filters, qOpts) => withQueryBudget(async () => {
    await waitForRateLimit(url);
    try { const r = await origQuery(filters, qOpts); recordRelaySuccess(url); return r; }
    catch (e) { recordRelayFailure(url); throw e; }
  }, { priority: lookupPriority(filters) });
  inner.event = async (event, eOpts) => {
    await waitForRateLimit(url);
    try { await origEvent(event, eOpts); recordRelaySuccess(url); }
    catch (e) { recordRelayFailure(url); throw e; }
  };
  return inner;
}

// ============================================================================
// Welshman Router integration (parity with web NostrProvider)
// ============================================================================

let _currentUserPubkeyForRouter: string | undefined;
export function _setRouterUserPubkey(pubkey: string | undefined): void {
  _currentUserPubkeyForRouter = pubkey;
}
let _routerConfigured = false;
function ensureRouterConfigured(): void {
  if (_routerConfigured) return;
  _routerConfigured = true;
  Router.configure({
    getUserPubkey: () => _currentUserPubkeyForRouter,
    getPubkeyRelays: (pubkey: string) => {
      const cached = getRelayCache(pubkey);
      return cached.filter(isSecureRelay);
    },
    getDefaultRelays: () => [...FALLBACK_RELAYS, ...READ_ONLY_RELAYS],
    getIndexerRelays: () => [...FALLBACK_RELAYS],
    getRelayQuality: (url: string) => isRelayBlocked(url) ? 0 : getRelayWeight(url),
    getLimit: () => MAX_TARGETED_RELAYS,
  });
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

// Coverage-ranked relay set for bulk feeds (follows feed + large corkboards) —
// the bounded outbox model. Union of user read relays + fallbacks/indexers + the
// followed authors' own write relays ranked by coverage, capped at
// MAX_FEED_RELAYS. Keep in sync with web selectFeedRelays.
function selectFeedRelays(authors: string[]): string[] {
  const selected = new Set<string>();
  const userRelays = getUserRelays();
  userRelays.read.forEach(r => selected.add(r));
  FALLBACK_RELAYS.forEach(r => selected.add(r));
  READ_ONLY_RELAYS.forEach(r => selected.add(r));

  const coverage = new Map<string, number>();
  for (const author of authors) {
    const relays = relayCache.get(author);
    if (!relays) continue;
    for (const r of relays) {
      if (selected.has(r) || isRelayBlocked(r)) continue;
      coverage.set(r, (coverage.get(r) ?? 0) + 1);
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

// ============================================================================
// Pool factory
// ============================================================================

function createPool(): NPoolType {
  ensureRouterConfigured();
  return new NPool({
    open(url: string) {
      return createRelay(url, { backoff: false });
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
        // Tier 1 — Bulk feed query (follows feed + large corkboards): bounded
        // outbox model via selectFeedRelays (coverage-ranked author write relays
        // + user reads + fallbacks/indexers), instead of a flat 2 relays.
        const capped = selectFeedRelays(authors);

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
        userRelays.read.forEach(r => relaysToQuery.add(r));
        FALLBACK_RELAYS.forEach(r => relaysToQuery.add(r));
        READ_ONLY_RELAYS.forEach(r => relaysToQuery.add(r));
        const all = Array.from(relaysToQuery);
        const healthy = all.filter(r => !isRelayBlocked(r));
        const blocked = all.filter(r => isRelayBlocked(r));
        const capped = [...healthy, ...blocked].slice(0, MAX_REFERENCE_RELAYS);
        for (const relay of capped) routes.set(relay, filters);
      } else {
        // Tier 2 — Targeted query: delegate to welshman's getFilterSelections
        // for proper outbox routing with fallback policy.
        const selections = getFilterSelections(filters as unknown as Filter[]);
        for (const sel of selections) {
          const cappedRelays = sel.relays.slice(0, MAX_TARGETED_RELAYS);
          for (const relay of cappedRelays) {
            const existing = routes.get(relay) ?? [];
            routes.set(relay, [...existing, ...(sel.filters as unknown as NostrFilter[])]);
          }
        }
        // Welshman can return empty for non-author queries (#p tags); always
        // include fallback + read-only for resilience.
        if (routes.size === 0) {
          [...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]
            .slice(0, MAX_TARGETED_RELAYS)
            .forEach(r => routes.set(r, filters));
        }
      }
      return routes;
    },

    eventRouter(event: NostrEvent) {
      // Welshman picks user's write relays + author's outbox; add minimal
      // fallback only when the user has nothing else configured.
      const urls = Router.get()
        .PublishEvent(event as unknown as TrustedEvent)
        .policy(addMinimalFallbacks)
        .limit(MAX_TARGETED_RELAYS)
        .getUrls();
      return urls.length > 0 ? urls : FALLBACK_RELAYS.slice(0, MAX_TARGETED_RELAYS);
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

/**
 * Wrap an NPool so every `query` call inherits the current session abort
 * signal. Callers can still pass their own `signal` (typically a timeout);
 * we compose both so EITHER the timeout OR the session bump aborts.
 *
 * Without this, in-flight queries for account A keep running after the user
 * switches to account B and can write stale results into the new UI.
 */
function wrapPoolWithSessionAbort(pool: NPoolType): NPoolType {
  const origQuery = pool.query.bind(pool);
  const origReq = pool.req?.bind(pool);
  pool.query = ((filters: NostrFilter[], opts?: { signal?: AbortSignal }) => {
    const sessionSignal = getSessionSignal();
    const composed = opts?.signal
      ? AbortSignal.any([opts.signal, sessionSignal])
      : sessionSignal;
    return origQuery(filters, { ...opts, signal: composed });
  }) as NPoolType['query'];
  if (origReq) {
    pool.req = ((filters: NostrFilter[], opts?: { signal?: AbortSignal }) => {
      const sessionSignal = getSessionSignal();
      const composed = opts?.signal
        ? AbortSignal.any([opts.signal, sessionSignal])
        : sessionSignal;
      return origReq(filters, { ...opts, signal: composed });
    }) as NPoolType['req'];
  }
  return pool;
}

export function NostrProvider({ children }: { children: React.ReactNode }) {
  const [pool] = useState<NPoolType>(() => wrapPoolWithSessionAbort(createPool()));
  const value = useMemo(() => ({ nostr: pool }), [pool]);
  return <NostrContext.Provider value={value}>{children}</NostrContext.Provider>;
}

/**
 * Headless bridge that keeps welshman's Router in sync with the active user.
 * Mount inside AuthProvider so useAuth() is available; renders nothing.
 * Web does this inside its NostrProvider via NostrLoginProvider — mobile uses
 * AuthContext which is below NostrProvider in the tree, hence this bridge.
 */
export function WelshmanRouterBridge(): null {
  const { pubkey, signer } = useAuth();
  useEffect(() => {
    _setRouterUserPubkey(pubkey ?? undefined);
    // Register the active signer for NIP-42 relay AUTH challenges (parity with web).
    setRelayAuthSigner((signer as AuthSigner | null) ?? null);
  }, [pubkey, signer]);
  return null;
}

export function useNostr(): NostrContextValue {
  const ctx = useContext(NostrContext);
  if (!ctx) throw new Error('useNostr must be used within NostrProvider');
  return ctx;
}
