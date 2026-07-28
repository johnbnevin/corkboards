/**
 * Pure pagination helpers shared by web and mobile.
 *
 * The actual hook (state, useEffect, network) stays per-platform because
 * each runtime has its own React-Query client, Nostr pool type, and
 * cache adapter. But the *logic* — figuring out the next `until` cursor,
 * deduping, counting undismissed adds — is platform-agnostic and worth
 * extracting so the two implementations can't drift.
 *
 * No DOM, no React, no platform types. Imports only from @nostrify/nostrify.
 */
import type { NostrEvent } from '@nostrify/nostrify';

/** Maximum loops in iterative-undismissed pagination before bailing. */
export const PAGINATION_MAX_ITERATIONS = 5;

/** Result of dedup+slice of a raw relay response. */
export interface DedupResult {
  /** Events seen for the first time (not yet in the cache). */
  trulyNew: NostrEvent[];
  /** Oldest created_at across the raw batch — used to advance the cursor. */
  oldestReturned: number;
}

/**
 * Dedup a raw relay response against an existing-id set, sort newest-first,
 * and report the oldest timestamp returned (used to advance the cursor).
 *
 * The oldest timestamp is computed across the *full raw batch*, not just
 * truly-new events — otherwise a batch full of duplicates would loop on
 * the same window forever.
 */
export function dedupBatch(raw: NostrEvent[], existingIds: ReadonlySet<string>): DedupResult {
  if (raw.length === 0) {
    return { trulyNew: [], oldestReturned: 0 };
  }
  // Dedup within the batch (pool can return duplicates from multiple relays).
  // Keeping the first-seen copy is correct here: a Nostr event `id` is the
  // SHA-256 of its serialized content, so any two events sharing an id are
  // byte-identical (unlike thread dedup, which prefers richer tag copies).
  const seen = new Set<string>();
  const deduped: NostrEvent[] = [];
  let oldest = raw[0].created_at;
  for (const e of raw) {
    if (e.created_at < oldest) oldest = e.created_at;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    deduped.push(e);
  }
  deduped.sort((a, b) => b.created_at - a.created_at);
  const trulyNew = deduped.filter(n => !existingIds.has(n.id));
  return { trulyNew, oldestReturned: oldest };
}

/**
 * Initial `until` cursor: oldest cached event minus one, or now if cache empty.
 *
 * PRECONDITION: `existing` is sorted NEWEST-FIRST (descending `created_at`) —
 * the order `dedupBatch` returns and the order the feed keeps its cache in. The
 * last element is therefore the oldest event, and one second before it is where
 * the next page starts. Hand this an unsorted or ascending array and the cursor
 * is taken from the newest event instead, which re-requests the page you already
 * have and makes pagination appear to stall.
 */
export function initialUntilCursor(existing: NostrEvent[]): number {
  if (existing.length === 0) return Math.floor(Date.now() / 1000);
  return existing[existing.length - 1].created_at - 1;
}
