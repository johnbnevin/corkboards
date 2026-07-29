/**
 * Bulk kind-0 profile fetching — the network half of the web and mobile
 * `useBulkAuthors` hooks, shared so the two cannot drift.
 *
 * The individual per-card profile fetch (useAuthor) has always raced the pool
 * against the profile indexers (purplepag.es, relay.nostr.band), because
 * ordinary relays are missing kind-0 for a lot of authors. The BULK path only
 * asked the pool — so every profile the bulk pass missed fell through to the
 * per-card path, which is deliberately capped at 6 concurrent fetches (WebKit
 * crashes above ~50 open sockets). A few hundred cold profiles trickling in
 * 6-at-a-time with 4s timeouts is minutes of gray placeholders. Querying the
 * indexers per batch here is what turns that into a few seconds.
 */
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { PROFILE_INDEXER_RELAYS } from './relayConstants';

/** Authors per kind-0 batch query. */
export const PROFILE_BATCH_SIZE = 100;

/**
 * Ceiling on pubkeys per bulk call. Was 500 on web (100 on mobile!), which
 * silently handed the overflow of a large view to the 6-concurrent per-card
 * trickle from the start.
 */
export const MAX_BULK_PROFILE_FETCH = 1000;

interface QueryTarget {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
}

/** The subset of an NPool both platforms expose. */
export interface ProfilePool extends QueryTarget {
  relay(url: string): QueryTarget;
}

/** Keep the newest kind-0 per pubkey — relays can disagree on a replaceable. */
function collect(into: Map<string, NostrEvent>, events: NostrEvent[]): void {
  for (const ev of events) {
    if (ev.kind !== 0) continue;
    const cur = into.get(ev.pubkey);
    if (!cur || ev.created_at > cur.created_at) into.set(ev.pubkey, ev);
  }
}

/**
 * Fetch kind-0 events for `pubkeys`, batched, querying the pool AND the
 * profile indexers in parallel for every batch. Unresolved leftovers get one
 * indexer-only retry (a batch that timed out on startup congestion usually
 * succeeds moments later). Returns newest event per pubkey; absent pubkeys
 * simply have no entry.
 */
export async function fetchProfilesBulk(
  pool: ProfilePool,
  pubkeys: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Map<string, NostrEvent>> {
  const out = new Map<string, NostrEvent>();
  const targets = pubkeys.slice(0, MAX_BULK_PROFILE_FETCH);
  if (targets.length === 0) return out;
  const timeoutMs = opts?.timeoutMs ?? 8000;

  const mkSignal = () => opts?.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  const queryBatch = async (batch: string[], sources: QueryTarget[]) => {
    const filter: NostrFilter[] = [{ kinds: [0], authors: batch, limit: batch.length }];
    const results = await Promise.allSettled(
      sources.map(s => s.query(filter, { signal: mkSignal() })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') collect(out, r.value);
    }
  };

  const batches: string[][] = [];
  for (let i = 0; i < targets.length; i += PROFILE_BATCH_SIZE) {
    batches.push(targets.slice(i, i + PROFILE_BATCH_SIZE));
  }

  const indexers = PROFILE_INDEXER_RELAYS.map(u => pool.relay(u));
  await Promise.allSettled(batches.map(b => queryBatch(b, [pool, ...indexers])));

  // Retry pass for the stragglers — but only when SOMETHING resolved. A total
  // miss means we're offline or every relay is down, and a retry just doubles
  // the pointless wait.
  const unresolved = targets.filter(pk => !out.has(pk));
  if (unresolved.length > 0 && unresolved.length < targets.length) {
    const retryBatches: string[][] = [];
    for (let i = 0; i < unresolved.length; i += PROFILE_BATCH_SIZE) {
      retryBatches.push(unresolved.slice(i, i + PROFILE_BATCH_SIZE));
    }
    await Promise.allSettled(retryBatches.map(b => queryBatch(b, indexers)));
  }

  return out;
}
