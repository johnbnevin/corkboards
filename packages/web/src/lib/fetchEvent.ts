/**
 * fetchEvent — Standalone event fetching using outbox model.
 *
 * Used by NoteCard, NoteLink, useParentNotes, and NotificationCard
 * for fetching individual events outside of the thread system.
 *
 * Uses a two-phase approach:
 *   Phase 1: NPool query + relay hints + cached author relays + fallbacks (parallel race)
 *   Phase 2: Discover author's NIP-65 relay list and query those relays
 */
import type { NostrEvent, NRelay1 } from '@nostrify/nostrify'
import { getRelayCache, updateRelayCache, FALLBACK_RELAYS, READ_ONLY_RELAYS, createRelayFresh } from '@/components/NostrProvider'
import { isSecureRelay } from '@core/nostrUtils'
import { FETCH_EVENT_CACHE_TTL_MS as CACHE_TTL_MS } from '@core/cacheConfig'
import { isTauri, tauriRelayQuery } from '@/lib/tauri'

/**
 * Extra time every relay query gets on desktop.
 *
 * The two builds reach relays very differently. On web, NPool holds persistent
 * sockets open, so a repeat query is one frame on an established connection and
 * a 2.5 s budget is generous. On desktop every query crosses the Rust bridge to
 * `do_query`, which performs a full DNS + TCP + TLS + WebSocket handshake for
 * that one query and then throws the connection away — there is no pool behind
 * it. The same millisecond budget therefore buys far less actual querying, and
 * the shortfall lands exactly where it was reported: "failed to load event" and
 * gray nested-content placeholders appearing far more often on Linux desktop
 * than on web, for events that are perfectly reachable.
 *
 * The right long-term fix is connection reuse in Rust; until then, pay for the
 * handshake explicitly instead of silently spending the query's budget on it.
 */
const CONNECT_OVERHEAD_MS = isTauri ? 2500 : 0

// Cap concurrent outbox event fetches — each fetchEventWithOutbox may open several
// fresh WebSocket connections (phase-1 hints + phase-2 author relays). Without a cap,
// 33 missing parent notes firing simultaneously = 100+ concurrent connections → WebKit OOM.
//
// That OOM is a WebKitGTK-WebSocket problem, and desktop doesn't use WebKit's
// WebSockets at all — those sockets are tokio's, in the host process. Holding
// desktop to the same cap of 4 just serialized the queue: with each fetch now
// budgeted for a handshake, a screenful of missing parents could take the better
// part of a minute to drain, which is what leaves placeholders grey.
const MAX_CONCURRENT_OUTBOX_FETCHES = isTauri ? 8 : 4;
let _activeOutboxFetches = 0;
const _outboxFetchQueue: Array<() => void> = [];

function withOutboxLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (_activeOutboxFetches < MAX_CONCURRENT_OUTBOX_FETCHES) {
    _activeOutboxFetches++;
    return fn().finally(() => {
      _activeOutboxFetches--;
      _outboxFetchQueue.shift()?.();
    });
  }
  return new Promise<T>((resolve, reject) => {
    _outboxFetchQueue.push(() => {
      _activeOutboxFetches++;
      fn().then(resolve, reject).finally(() => {
        _activeOutboxFetches--;
        _outboxFetchQueue.shift()?.();
      });
    });
  });
}

// ── Session cache (shared with thread system) ─────────────────────────────
const MAX_EVENT_CACHE = 750
// CACHE_TTL_MS imported above from @core/cacheConfig

const eventCache = new Map<string, NostrEvent>()
const eventCacheTimestamps = new Map<string, number>()

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  map.delete(key)
  while (map.size >= maxSize) map.delete(map.keys().next().value!)
  map.set(key, value)
}

export function getCachedEvent(id: string): NostrEvent | undefined {
  const ts = eventCacheTimestamps.get(id)
  if (ts && Date.now() - ts > CACHE_TTL_MS) {
    eventCache.delete(id)
    eventCacheTimestamps.delete(id)
    return undefined
  }
  return eventCache.get(id)
}

export function setCachedEvent(id: string, event: NostrEvent): void {
  lruSet(eventCache, id, event, MAX_EVENT_CACHE)
  eventCacheTimestamps.set(id, Date.now())
}

export function clearEventCache(eventId?: string) {
  if (eventId) {
    eventCache.delete(eventId)
    eventCacheTimestamps.delete(eventId)
  } else {
    eventCache.clear()
    eventCacheTimestamps.clear()
  }
}

// ── Relay helpers ──────────────────────────────────────────────────────────

export async function queryRelay(
  relayUrl: string,
  filter: { ids?: string[]; kinds?: number[]; '#e'?: string[]; authors?: string[]; '#d'?: string[]; limit?: number },
  timeoutMs = 2500 + CONNECT_OVERHEAD_MS,
): Promise<NostrEvent[]> {
  // In Tauri: use native Rust WebSocket to bypass WebKitGTK's WebSocket implementation.
  // WebKitGTK crashes with too many concurrent WebSocket connections on Linux.
  if (isTauri) {
    const result = await tauriRelayQuery(relayUrl, filter as Record<string, unknown>, timeoutMs);
    if (result && !result.error) return result.events as NostrEvent[];
    return [];
  }

  const events: NostrEvent[] = []
  let relay: NRelay1 | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    relay = createRelayFresh(relayUrl, { backoff: false })
    timeout = setTimeout(() => relay!.close(), timeoutMs)
    for await (const msg of relay.req([filter])) {
      if (msg[0] === 'EVENT') events.push(msg[2] as NostrEvent)
      else if (msg[0] === 'EOSE') break
    }
  } catch {
    // Relay failed or timed out
  } finally {
    clearTimeout(timeout)
    relay?.close()
  }
  return events
}

// (M5) Single-flight cache: concurrent parent-note fetches for the same author
// would each re-discover kind-10002 across all fallback relays. Coalesce them
// into one in-flight promise per pubkey; the entry is cleared once it settles.
const _authorRelaysInFlight = new Map<string, Promise<string[]>>()

async function fetchAuthorRelays(pubkey: string): Promise<string[]> {
  const cached = getRelayCache(pubkey)
  if (cached.length > 0) return cached

  const inFlight = _authorRelaysInFlight.get(pubkey)
  if (inFlight) return inFlight

  const promise = (async (): Promise<string[]> => {
    const discoveryRelays = [...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]
    const relayLists = await Promise.all(
      discoveryRelays.map(relay =>
        queryRelay(relay, { kinds: [10002], authors: [pubkey], limit: 1 }, 3000 + CONNECT_OVERHEAD_MS)
          .then(events => events[0] || null)
          .catch(() => null)
      )
    )

    const best = relayLists
      .filter((e): e is NostrEvent => e !== null)
      .sort((a, b) => b.created_at - a.created_at)[0]

    if (best) {
      const relays = best.tags
        .filter(t => t[0] === 'r' && t[1]?.startsWith('wss://'))
        .map(t => t[1])
        .slice(0, 10)
      if (relays.length > 0) updateRelayCache(pubkey, relays)
      return relays
    }
    return []
  })()

  _authorRelaysInFlight.set(pubkey, promise)
  try {
    return await promise
  } finally {
    _authorRelaysInFlight.delete(pubkey)
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

type NostrLike = { query: (filters: unknown[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> }

/**
 * Fetch a single event using outbox model routing.
 * Races NPool + relay hints + author relays + fallbacks.
 */
async function _fetchEventWithOutboxImpl(
  eventId: string,
  nostr: NostrLike,
  opts?: {
    onRelayTried?: (r: string) => void
    hints?: string[]
    authorPubkey?: string
  },
): Promise<NostrEvent | null> {
  const cached = getCachedEvent(eventId)
  if (cached) return cached

  const hints = (opts?.hints || []).filter(isSecureRelay)
  const authorPubkey = opts?.authorPubkey

  // Phase 1: Race NPool (covers fallbacks + author relays via reqRouter) + hint-only relays.
  // Only open standalone connections to hints that NPool wouldn't cover.
  const poolRelays = new Set<string>([...FALLBACK_RELAYS, ...READ_ONLY_RELAYS])
  if (authorPubkey) getRelayCache(authorPubkey).slice(0, 3).forEach(r => poolRelays.add(r))
  const hintOnly = hints.filter(r => !poolRelays.has(r))

  const racePromises: Promise<NostrEvent | null>[] = [
    nostr.query([{ ids: [eventId], limit: 1 }], { signal: AbortSignal.timeout(3000 + CONNECT_OVERHEAD_MS) })
      .then(events => events[0] || null)
      .catch(() => null),
    ...hintOnly.map(relay =>
      queryRelay(relay, { ids: [eventId], limit: 1 })
        .then(events => events[0] || null)
        .catch(() => null)
    ),
  ]

  const raceTimeout = new Promise<NostrEvent | null>(resolve => setTimeout(() => resolve(null), 4000 + CONNECT_OVERHEAD_MS))
  let result = await Promise.race([
    ...racePromises.map(p => p.then(r => { if (r) return r; throw new Error('skip') })),
    raceTimeout,
  ]).catch(() => null as NostrEvent | null)

  if (!result) {
    // (M4) Hard-cap the fallback: Promise.all(racePromises) can otherwise block
    // on the slowest relay long past the 4s race timeout. Race it against the
    // same deadline so a slow relay can't hang the call.
    const fallbackDeadline = new Promise<null>(resolve => setTimeout(() => resolve(null), 4000 + CONNECT_OVERHEAD_MS))
    const all = await Promise.race([Promise.all(racePromises), fallbackDeadline])
    result = all?.find(e => e !== null) || null
  }

  if (result) { setCachedEvent(eventId, result); return result }

  // Phase 2: Discover author's outbox relays
  if (authorPubkey) {
    const authorRelays = await fetchAuthorRelays(authorPubkey)
    if (authorRelays.length > 0) {
      const outboxResults = await Promise.all(
        authorRelays.slice(0, 3).map(relay =>
          queryRelay(relay, { ids: [eventId], limit: 1 })
            .then(events => events[0] || null)
            .catch(() => null)
        )
      )
      result = outboxResults.find(e => e !== null) || null
      if (result) { setCachedEvent(result.id, result); return result }
    }
  }

  return null
}

export function fetchEventWithOutbox(
  eventId: string,
  nostr: NostrLike,
  opts?: { onRelayTried?: (r: string) => void; hints?: string[]; authorPubkey?: string },
): Promise<NostrEvent | null> {
  return withOutboxLimit(() => _fetchEventWithOutboxImpl(eventId, nostr, opts));
}

/**
 * Fetch a replaceable event (naddr) using outbox model routing.
 */
export async function fetchNaddrWithOutbox(
  kind: number,
  pubkey: string,
  identifier: string,
  nostr: NostrLike,
  hints?: string[],
): Promise<NostrEvent | null> {
  const filter = { kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 }
  const safeHints = (hints || []).filter(isSecureRelay)

  // NPool covers fallbacks + author relays via reqRouter. Only open standalone connections to hints.
  const poolRelays = new Set<string>([...FALLBACK_RELAYS, ...READ_ONLY_RELAYS])
  getRelayCache(pubkey).slice(0, 3).forEach(r => poolRelays.add(r))
  const hintOnly = safeHints.filter(r => !poolRelays.has(r))

  const racePromises: Promise<NostrEvent | null>[] = [
    nostr.query([filter], { signal: AbortSignal.timeout(3000 + CONNECT_OVERHEAD_MS) })
      .then(events => events[0] || null)
      .catch(() => null),
    ...hintOnly.map(relay =>
      queryRelay(relay, filter)
        .then(events => events[0] || null)
        .catch(() => null)
    ),
  ]

  const raceTimeout = new Promise<NostrEvent | null>(resolve => setTimeout(() => resolve(null), 4000 + CONNECT_OVERHEAD_MS))
  let result = await Promise.race([
    ...racePromises.map(p => p.then(r => { if (r) return r; throw new Error('skip') })),
    raceTimeout,
  ]).catch(() => null as NostrEvent | null)

  if (!result) {
    // (M4) Hard-cap the fallback: Promise.all(racePromises) can otherwise block
    // on the slowest relay long past the 4s race timeout. Race it against the
    // same deadline so a slow relay can't hang the call.
    const fallbackDeadline = new Promise<null>(resolve => setTimeout(() => resolve(null), 4000 + CONNECT_OVERHEAD_MS))
    const all = await Promise.race([Promise.all(racePromises), fallbackDeadline])
    result = all?.find(e => e !== null) || null
  }

  if (result) { setCachedEvent(result.id, result); return result }

  // Phase 2: Author outbox discovery
  const authorRelays = await fetchAuthorRelays(pubkey)
  if (authorRelays.length > 0) {
    const all = await Promise.all(
      authorRelays.slice(0, 3).map(relay =>
        queryRelay(relay, filter).then(events => events[0] || null).catch(() => null)
      )
    )
    result = all.find(e => e !== null) || null
    if (result) { setCachedEvent(result.id, result); return result }
  }

  return null
}

// Re-export cache helpers for consumers that need them
export { getCachedEvent as getCachedThreadEvent }
