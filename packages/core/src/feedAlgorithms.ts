/**
 * Pure feed list algorithms — shared by web and mobile.
 *
 * These were inlined (dedupe-then-sort) in several fetch helpers on both
 * platforms; centralizing them keeps the ordering/dedup invariant identical
 * everywhere. No DOM, React, or network dependencies.
 */
import type { NostrEvent } from '@nostrify/nostrify';

/** Deduplicate events by id and sort by created_at descending (newest first). */
export function deduplicateAndSort(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const deduped = events.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return deduped.sort((a, b) => b.created_at - a.created_at);
}

/**
 * Merge incoming events into an existing array, deduplicating by id. Returns the
 * same `existing` reference unchanged when nothing is new (lets callers skip
 * re-renders), otherwise a new sorted array.
 */
export function mergeEvents(existing: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const existingIds = new Set(existing.map(e => e.id));
  const trulyNew = incoming.filter(e => !existingIds.has(e.id));
  if (trulyNew.length === 0) return existing;
  return [...existing, ...trulyNew].sort((a, b) => b.created_at - a.created_at);
}
