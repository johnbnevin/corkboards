/**
 * Pure feed list algorithms — shared by web and mobile.
 *
 * These were inlined (dedupe-then-sort) in several fetch helpers on both
 * platforms; centralizing them keeps the ordering/dedup invariant identical
 * everywhere. No DOM, React, or network dependencies.
 */
import type { NostrEvent } from '@nostrify/nostrify';

// NIP-01 event categories that collapse to a single latest revision.
function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}
function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/**
 * The replaceable/addressable coordinate that identifies "the same event across
 * revisions": `kind:pubkey` for replaceable, `kind:pubkey:dTag` for addressable
 * (parameterized). Returns null for regular/ephemeral events (deduped by id).
 */
export function replaceableCoordinate(e: NostrEvent): string | null {
  if (isAddressable(e.kind)) {
    const d = e.tags.find(t => t[0] === 'd')?.[1] ?? '';
    return `${e.kind}:${e.pubkey}:${d}`;
  }
  if (isReplaceable(e.kind)) return `${e.kind}:${e.pubkey}`;
  return null;
}

/**
 * Deduplicate events and sort by created_at descending (newest first).
 *
 * Regular events dedupe by id. Replaceable/addressable events (kind 0, 3,
 * 10000–19999, 30000–39999 — e.g. long-form 30023, video 34235, relay lists,
 * profiles) collapse to a SINGLE latest revision per coordinate, keeping the
 * highest created_at (NIP-01 tie-break: lowest id wins on equal timestamps).
 * Without this an edited long-form note shows twice, or a stale copy wins. (H2)
 */
export function deduplicateAndSort(events: NostrEvent[]): NostrEvent[] {
  const seenIds = new Set<string>();
  const byCoord = new Map<string, NostrEvent>();
  const regular: NostrEvent[] = [];
  for (const e of events) {
    const coord = replaceableCoordinate(e);
    if (coord) {
      const cur = byCoord.get(coord);
      if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id < cur.id)) {
        byCoord.set(coord, e);
      }
    } else if (!seenIds.has(e.id)) {
      seenIds.add(e.id);
      regular.push(e);
    }
  }
  return [...regular, ...byCoord.values()].sort((a, b) => b.created_at - a.created_at);
}

/**
 * Merge incoming events into an existing array. Returns the same `existing`
 * reference unchanged when nothing is new (lets callers skip re-renders),
 * otherwise a fully re-collapsed, sorted array (so a newer revision of a
 * replaceable/addressable event supersedes the stale copy already present).
 */
export function mergeEvents(existing: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const existingIds = new Set(existing.map(e => e.id));
  const trulyNew = incoming.filter(e => !existingIds.has(e.id));
  if (trulyNew.length === 0) return existing;
  return deduplicateAndSort([...existing, ...trulyNew]);
}
