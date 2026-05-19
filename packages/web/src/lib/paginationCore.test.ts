/**
 * Tests for the pure pagination helpers shared by web and mobile.
 * These run in jsdom but only depend on @core — no platform types.
 */
import { describe, it, expect } from 'vitest';
import { dedupBatch, initialUntilCursor, PAGINATION_MAX_ITERATIONS } from '@core/paginationCore';
import type { NostrEvent } from '@nostrify/nostrify';

function fakeEvent(id: string, ts: number): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: ts,
    kind: 1,
    tags: [],
    content: '',
    sig: 'b'.repeat(128),
  };
}

describe('dedupBatch', () => {
  it('returns empty when raw is empty', () => {
    const result = dedupBatch([], new Set());
    expect(result.trulyNew).toEqual([]);
    expect(result.oldestReturned).toBe(0);
  });

  it('removes duplicates within the batch', () => {
    const raw = [fakeEvent('a', 100), fakeEvent('a', 100), fakeEvent('b', 90)];
    const { trulyNew } = dedupBatch(raw, new Set());
    expect(trulyNew.map(e => e.id)).toEqual(['a', 'b']);
  });

  it('filters out events already in existingIds', () => {
    const raw = [fakeEvent('a', 100), fakeEvent('b', 90), fakeEvent('c', 80)];
    const { trulyNew } = dedupBatch(raw, new Set(['a', 'c']));
    expect(trulyNew.map(e => e.id)).toEqual(['b']);
  });

  it('sorts trulyNew newest-first', () => {
    const raw = [fakeEvent('a', 50), fakeEvent('b', 200), fakeEvent('c', 100)];
    const { trulyNew } = dedupBatch(raw, new Set());
    expect(trulyNew.map(e => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('reports oldestReturned across the FULL raw batch (not just trulyNew)', () => {
    // Critical for cursor advancement: if all "new" events were duplicates,
    // we still need to push the cursor past the oldest seen.
    const raw = [fakeEvent('a', 100), fakeEvent('b', 50)];
    const { oldestReturned } = dedupBatch(raw, new Set(['a', 'b']));
    expect(oldestReturned).toBe(50);
  });
});

describe('initialUntilCursor', () => {
  it('returns approximately now for empty cache', () => {
    const now = Math.floor(Date.now() / 1000);
    const cursor = initialUntilCursor([]);
    expect(cursor).toBeGreaterThanOrEqual(now - 1);
    expect(cursor).toBeLessThanOrEqual(now + 1);
  });

  it('returns oldest-cached-minus-one when cache is populated', () => {
    const cache = [fakeEvent('a', 200), fakeEvent('b', 100), fakeEvent('c', 50)];
    expect(initialUntilCursor(cache)).toBe(49);
  });
});

describe('PAGINATION_MAX_ITERATIONS', () => {
  it('is a sane positive integer', () => {
    expect(PAGINATION_MAX_ITERATIONS).toBeGreaterThan(0);
    expect(PAGINATION_MAX_ITERATIONS).toBeLessThan(100);
    expect(Number.isInteger(PAGINATION_MAX_ITERATIONS)).toBe(true);
  });
});
