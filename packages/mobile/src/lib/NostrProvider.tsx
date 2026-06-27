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
const MAX_BULK_RELAYS = 2;
const MAX_TARGETED_RELAYS = 3;
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

/** Dummy relay returned during backoff — returns empty results without opening a connection */
const blockedQuery = async () => [] as NostrEvent[];
const blockedEvent = async () => { /* noop */ };

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

/**
 * Relays we'll auto-answer a NIP-42 AUTH challenge for: the user's own
 * configured (NIP-65) relays plus the app's default relay sets. A NIP-42 AUTH
 * response is a SIGNED event that cryptographically binds the user's pubkey to
 * their IP/connection at that relay — a passive de-anonymization primitive. We
 * MUST NOT auto-authenticate to arbitrary relays pulled in during outbox
 * fan-out (other authors' relays); unknown relays are declined (the query just
 * returns nothing from them). Mirrors web's isRelayAuthAllowed.
 */
function isRelayAuthAllowed(relayUrl: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, '');
  const target = norm(relayUrl);
  const { read, write } = getUserRelays();
  for (const u of [...read, ...write, ...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]) {
    if (norm(u) === target) return true;
  }
  return false;
}

async function handleRelayAuthChallenge(relayUrl: string, challenge: string): Promise<NostrEvent> {
  const signer = _authSigner;
  if (!signer) throw new Error('No active signer for NIP-42 relay AUTH');
  if (!isRelayAuthAllowed(relayUrl)) {
    // Don't bind the user's identity to a relay they never chose (NIP-42 de-anon).
    throw new Error(`Declining NIP-42 AUTH for non-configured relay: ${relayUrl}`);
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
    // Return a stub that fails fast without opening a WebSocket
    const stub = new NRelay1(url, { ...opts, backoff: false, idleTimeout: 1 });
    // Immediately close to prevent connection, override methods
    stub.close().catch(() => {});
    stub.query = blockedQuery;
    stub.event = blockedEvent;
    return stub;
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
  inner.query = async (filters, qOpts) => {
    await waitForRateLimit(url);
    try { const r = await origQuery(filters, qOpts); recordRelaySuccess(url); return r; }
    catch (e) { recordRelayFailure(url); throw e; }
  };
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
  inner.query = async (filters, qOpts) => {
    await waitForRateLimit(url);
    try { const r = await origQuery(filters, qOpts); recordRelaySuccess(url); return r; }
    catch (e) { recordRelayFailure(url); throw e; }
  };
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
