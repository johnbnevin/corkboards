/**
 * fetchEvent — Standalone event fetching using outbox model.
 *
 * Port of packages/web/src/lib/fetchEvent.ts for mobile.
 * Uses mobile's NostrProvider relay cache instead of web IDB.
 */
import type { NostrEvent, NostrFilter, NRelay1 } from '@nostrify/nostrify';
import { createRelayFresh } from './NostrProvider';
import { getRelayCache, updateRelayCache, FALLBACK_RELAYS, READ_ONLY_RELAYS } from './NostrProvider';
import { isSecureRelay } from '@core/nostrUtils';
import { nip65OutboxRelays } from './nip65';
import { FETCH_EVENT_CACHE_TTL_MS as CACHE_TTL_MS } from '@core/cacheConfig';
import { LAST_RESORT_LOOKUP_RELAYS } from '@core/relayConstants';

const MAX_CONCURRENT_OUTBOX_FETCHES = 4;
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

// ── Session cache ─────────────────────────────────────────────────────────
const MAX_EVENT_CACHE = 750;
// CACHE_TTL_MS imported above from @core/cacheConfig

const eventCache = new Map<string, NostrEvent>();
const eventCacheTimestamps = new Map<string, number>();

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  map.delete(key);
  while (map.size >= maxSize) map.delete(map.keys().next().value!);
  map.set(key, value);
}

export function getCachedEvent(id: string): NostrEvent | undefined {
  const ts = eventCacheTimestamps.get(id);
  if (ts && Date.now() - ts > CACHE_TTL_MS) {
    eventCache.delete(id);
    eventCacheTimestamps.delete(id);
    return undefined;
  }
  return eventCache.get(id);
}

export function setCachedEvent(id: string, event: NostrEvent): void {
  lruSet(eventCache, id, event, MAX_EVENT_CACHE);
  eventCacheTimestamps.set(id, Date.now());
}

export function clearEventCache(eventId?: string) {
  if (eventId) {
    eventCache.delete(eventId);
    eventCacheTimestamps.delete(eventId);
  } else {
    eventCache.clear();
    eventCacheTimestamps.clear();
  }
}

// ── Relay helpers ──────────────────────────────────────────────────────────

export async function queryRelay(
  relayUrl: string,
  filter: { ids?: string[]; kinds?: number[]; '#e'?: string[]; authors?: string[]; '#d'?: string[]; limit?: number },
  timeoutMs = 2500,
): Promise<NostrEvent[]> {
  const events: NostrEvent[] = [];
  let relay: NRelay1 | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    relay = createRelayFresh(relayUrl, { backoff: false });
    timeout = setTimeout(() => relay!.close(), timeoutMs);
    for await (const msg of relay.req([filter])) {
      if (msg[0] === 'EVENT') events.push(msg[2] as NostrEvent);
      else if (msg[0] === 'EOSE') break;
    }
  } catch {
    // Relay failed or timed out
  } finally {
    clearTimeout(timeout);
    relay?.close();
  }
  return events;
}

async function fetchAuthorRelays(pubkey: string): Promise<string[]> {
  const cached = getRelayCache(pubkey);
  if (cached.length > 0) return cached;

  const relayLists = await Promise.all(
    [...FALLBACK_RELAYS, ...READ_ONLY_RELAYS].map(relay =>
      queryRelay(relay, { kinds: [10002], authors: [pubkey], limit: 1 }, 3000)
        .then(events => events[0] || null)
        .catch(() => null)
    )
  );

  const best = relayLists
    .filter((e): e is NostrEvent => e !== null)
    .sort((a, b) => b.created_at - a.created_at)[0];

  if (best) {
    // Outbox only — see lib/nip65.ts. A `read`-marked relay is where the author
    // receives mentions, not where they publish, so querying it for their own
    // events returns nothing.
    const relays = nip65OutboxRelays(best.tags, 10);
    if (relays.length > 0) updateRelayCache(pubkey, relays);
    return relays;
  }
  return [];
}

// ── Public API ─────────────────────────────────────────────────────────────

type NostrLike = { query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]> };

async function _fetchEventWithOutboxImpl(
  eventId: string,
  nostr: NostrLike,
  opts?: {
    hints?: string[];
    authorPubkey?: string;
    /** Other pubkeys that might be the event's author (e.g. a reply's p-tags). */
    candidateAuthors?: string[];
  },
): Promise<NostrEvent | null> {
  const cached = getCachedEvent(eventId);
  if (cached) return cached;

  const hints = (opts?.hints || []).filter(isSecureRelay);
  const authorPubkey = opts?.authorPubkey;

  // Phase 1: NPool covers fallbacks + author relays via reqRouter. Only open standalone connections to hints.
  const poolRelays = new Set<string>([...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]);
  if (authorPubkey) getRelayCache(authorPubkey).slice(0, 3).forEach(r => poolRelays.add(r));
  const hintOnly = hints.filter(r => !poolRelays.has(r));

  const racePromises: Promise<NostrEvent | null>[] = [
    nostr.query([{ ids: [eventId], limit: 1 }], { signal: AbortSignal.timeout(3000) })
      .then(events => events[0] || null)
      .catch(() => null),
    ...hintOnly.map(relay =>
      queryRelay(relay, { ids: [eventId], limit: 1 })
        .then(events => events[0] || null)
        .catch(() => null)
    ),
  ];

  const raceTimeout = new Promise<NostrEvent | null>(resolve => setTimeout(() => resolve(null), 4000));
  let result = await Promise.race([
    ...racePromises.map(p => p.then(r => { if (r) return r; throw new Error('skip'); })),
    raceTimeout,
  ]).catch(() => null as NostrEvent | null);

  if (!result) {
    const all = await Promise.all(racePromises);
    result = all.find(e => e !== null) || null;
  }

  if (result) { setCachedEvent(eventId, result); return result; }

  // Phase 2: Discover outbox relays — the tagged author first, then other
  // thread participants. A reply's e-tag often omits the parent author and
  // its first p-tag is frequently the wrong person; NIP-10 only guarantees
  // the parent's author is SOMEWHERE in the p-tags, so when the primary
  // author's relays miss, walk the others. Bounded: 3 authors total, primary
  // gets 3 relays, candidates 2 each, phase-1 relays skipped. (Mirrors web.)
  const candidates = [authorPubkey, ...(opts?.candidateAuthors ?? [])]
    .filter((p, i, arr): p is string => !!p && arr.indexOf(p) === i)
    .slice(0, 3);
  const tried = new Set<string>([...poolRelays, ...hints]);
  for (const author of candidates) {
    const authorRelays = (await fetchAuthorRelays(author))
      .filter(r => !tried.has(r))
      .slice(0, author === authorPubkey ? 3 : 2);
    if (authorRelays.length === 0) continue;
    authorRelays.forEach(r => tried.add(r));
    const outboxResults = await Promise.all(
      authorRelays.map(relay =>
        queryRelay(relay, { ids: [eventId], limit: 1 })
          .then(events => events[0] || null)
          .catch(() => null)
      )
    );
    result = outboxResults.find(e => e !== null) || null;
    if (result) { setCachedEvent(result.id, result); return result; }
  }

  return null;
}

export function fetchEventWithOutbox(
  eventId: string,
  nostr: NostrLike,
  opts?: { hints?: string[]; authorPubkey?: string; candidateAuthors?: string[] },
): Promise<NostrEvent | null> {
  return withOutboxLimit(() => _fetchEventWithOutboxImpl(eventId, nostr, opts));
}

/**
 * The full escalation ladder for a USER-INITIATED retry: the normal outbox
 * lookup, and if that still misses, a parallel sweep of
 * LAST_RESORT_LOOKUP_RELAYS — archives, indexers and the big general relays.
 * Never used by automatic paths: a human clicked, so one burst of extra
 * sockets is proportionate. (Mirrors web.)
 */
export async function fetchEventLastResort(
  eventId: string,
  nostr: NostrLike,
  opts?: { hints?: string[]; authorPubkey?: string; candidateAuthors?: string[] },
): Promise<NostrEvent | null> {
  const viaOutbox = await fetchEventWithOutbox(eventId, nostr, opts);
  if (viaOutbox) return viaOutbox;

  const alreadyTried = new Set<string>([...FALLBACK_RELAYS, ...READ_ONLY_RELAYS, ...(opts?.hints ?? [])]);
  const sweep = LAST_RESORT_LOOKUP_RELAYS.filter(r => !alreadyTried.has(r));
  const results = await Promise.all(
    sweep.map(relay =>
      queryRelay(relay, { ids: [eventId], limit: 1 }, 8000)
        .then(events => events[0] || null)
        .catch(() => null)
    )
  );
  const found = results.find(e => e !== null) || null;
  if (found) setCachedEvent(found.id, found);
  return found;
}

export async function fetchNaddrWithOutbox(
  kind: number,
  pubkey: string,
  identifier: string,
  nostr: NostrLike,
  hints?: string[],
): Promise<NostrEvent | null> {
  const filter = { kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 };
  const safeHints = (hints || []).filter(isSecureRelay);

  // NPool covers fallbacks + author relays via reqRouter. Only open standalone connections to hints.
  const poolRelays = new Set<string>([...FALLBACK_RELAYS, ...READ_ONLY_RELAYS]);
  getRelayCache(pubkey).slice(0, 3).forEach(r => poolRelays.add(r));
  const hintOnly = safeHints.filter(r => !poolRelays.has(r));

  const racePromises: Promise<NostrEvent | null>[] = [
    nostr.query([filter], { signal: AbortSignal.timeout(3000) })
      .then(events => events[0] || null)
      .catch(() => null),
    ...hintOnly.map(relay =>
      queryRelay(relay, filter)
        .then(events => events[0] || null)
        .catch(() => null)
    ),
  ];

  const raceTimeout = new Promise<NostrEvent | null>(resolve => setTimeout(() => resolve(null), 4000));
  let result = await Promise.race([
    ...racePromises.map(p => p.then(r => { if (r) return r; throw new Error('skip'); })),
    raceTimeout,
  ]).catch(() => null as NostrEvent | null);

  if (!result) {
    const all = await Promise.all(racePromises);
    result = all.find(e => e !== null) || null;
  }

  if (result) { setCachedEvent(result.id, result); return result; }

  const authorRelays = await fetchAuthorRelays(pubkey);
  if (authorRelays.length > 0) {
    const all = await Promise.all(
      authorRelays.slice(0, 3).map(relay =>
        queryRelay(relay, filter).then(events => events[0] || null).catch(() => null)
      )
    );
    result = all.find(e => e !== null) || null;
    if (result) { setCachedEvent(result.id, result); return result; }
  }

  return null;
}

export { getCachedEvent as getCachedThreadEvent };
