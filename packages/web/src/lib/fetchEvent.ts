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
import { type NostrEvent, NRelay1 } from '@nostrify/nostrify'
import { getRelayCache, updateRelayCache, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { isSecureRelay } from '@core/nostrUtils'

// ── Session cache (shared with thread system) ─────────────────────────────
const MAX_EVENT_CACHE = 750
const CACHE_TTL_MS = 10 * 60 * 1000

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
  timeoutMs = 2500,
): Promise<NostrEvent[]> {
  const events: NostrEvent[] = []
  let relay: NRelay1 | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    relay = new NRelay1(relayUrl)
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

async function fetchAuthorRelays(pubkey: string): Promise<string[]> {
  const cached = getRelayCache(pubkey)
  if (cached.length > 0) return cached

  const discoveryRelays = FALLBACK_RELAYS
  const relayLists = await Promise.all(
    discoveryRelays.map(relay =>
      queryRelay(relay, { kinds: [10002], authors: [pubkey], limit: 1 }, 3000)
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
}

// ── Public API ─────────────────────────────────────────────────────────────

type NostrLike = { query: (filters: unknown[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> }

/**
 * Fetch a single event using outbox model routing.
 * Races NPool + relay hints + author relays + fallbacks.
 */
export async function fetchEventWithOutbox(
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

  // Phase 1: Race pool + hints + cached author relays + fallbacks
  const relaysToTry = new Set<string>()
  hints.forEach(r => relaysToTry.add(r))
  FALLBACK_RELAYS.forEach(r => relaysToTry.add(r))
  if (authorPubkey) {
    getRelayCache(authorPubkey).slice(0, 3).forEach(r => relaysToTry.add(r))
  }

  const racePromises: Promise<NostrEvent | null>[] = [
    nostr.query([{ ids: [eventId], limit: 1 }], { signal: AbortSignal.timeout(3000) })
      .then(events => events[0] || null)
      .catch(() => null),
    ...Array.from(relaysToTry).map(relay =>
      queryRelay(relay, { ids: [eventId], limit: 1 })
        .then(events => events[0] || null)
        .catch(() => null)
    ),
  ]

  const raceTimeout = new Promise<NostrEvent | null>(resolve => setTimeout(() => resolve(null), 4000))
  let result = await Promise.race([
    ...racePromises.map(p => p.then(r => { if (r) return r; throw new Error('skip') })),
    raceTimeout,
  ]).catch(() => null as NostrEvent | null)

  if (!result) {
    const all = await Promise.all(racePromises)
    result = all.find(e => e !== null) || null
  }

  if (result) { setCachedEvent(eventId, result); return result }

  // Phase 2: Discover author's outbox relays
  if (authorPubkey) {
    const authorRelays = await fetchAuthorRelays(authorPubkey)
    if (authorRelays.length > 0) {
      const outboxResults = await Promise.all(
        authorRelays.slice(0, 5).map(relay =>
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

  const relaysToTry = new Set<string>()
  safeHints.forEach(r => relaysToTry.add(r))
  FALLBACK_RELAYS.forEach(r => relaysToTry.add(r))
  getRelayCache(pubkey).slice(0, 3).forEach(r => relaysToTry.add(r))

  const racePromises: Promise<NostrEvent | null>[] = [
    nostr.query([filter], { signal: AbortSignal.timeout(3000) })
      .then(events => events[0] || null)
      .catch(() => null),
    ...Array.from(relaysToTry).map(relay =>
      queryRelay(relay, filter)
        .then(events => events[0] || null)
        .catch(() => null)
    ),
  ]

  const raceTimeout = new Promise<NostrEvent | null>(resolve => setTimeout(() => resolve(null), 4000))
  let result = await Promise.race([
    ...racePromises.map(p => p.then(r => { if (r) return r; throw new Error('skip') })),
    raceTimeout,
  ]).catch(() => null as NostrEvent | null)

  if (!result) {
    const all = await Promise.all(racePromises)
    result = all.find(e => e !== null) || null
  }

  if (result) { setCachedEvent(result.id, result); return result }

  // Phase 2: Author outbox discovery
  const authorRelays = await fetchAuthorRelays(pubkey)
  if (authorRelays.length > 0) {
    const all = await Promise.all(
      authorRelays.slice(0, 5).map(relay =>
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
