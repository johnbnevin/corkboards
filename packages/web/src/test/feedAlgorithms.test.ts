import { describe, it, expect } from 'vitest';
import { deduplicateAndSort, mergeEvents, replaceableCoordinate } from '@core/feedAlgorithms';
import type { NostrEvent } from '@nostrify/nostrify';

function ev(partial: Partial<NostrEvent> & { id: string; kind: number }): NostrEvent {
  return {
    id: partial.id,
    kind: partial.kind,
    pubkey: partial.pubkey ?? 'pk1',
    created_at: partial.created_at ?? 1000,
    content: partial.content ?? '',
    tags: partial.tags ?? [],
    sig: partial.sig ?? 'sig',
  };
}

describe('deduplicateAndSort', () => {
  it('dedupes regular events by id and sorts newest-first', () => {
    const a = ev({ id: 'a', kind: 1, created_at: 100 });
    const b = ev({ id: 'b', kind: 1, created_at: 300 });
    const c = ev({ id: 'c', kind: 1, created_at: 200 });
    const out = deduplicateAndSort([a, b, c, { ...a }]);
    expect(out.map(e => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('collapses addressable (30023) revisions to the newest by coordinate (H2)', () => {
    const old = ev({ id: 'old', kind: 30023, pubkey: 'pk1', created_at: 100, tags: [['d', 'post']] });
    const fresh = ev({ id: 'new', kind: 30023, pubkey: 'pk1', created_at: 500, tags: [['d', 'post']] });
    const out = deduplicateAndSort([old, fresh]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('new');
  });

  it('keeps distinct addressable events with different d-tags', () => {
    const p1 = ev({ id: 'p1', kind: 30023, pubkey: 'pk1', tags: [['d', 'one']] });
    const p2 = ev({ id: 'p2', kind: 30023, pubkey: 'pk1', tags: [['d', 'two']] });
    expect(deduplicateAndSort([p1, p2])).toHaveLength(2);
  });

  it('collapses replaceable events (kind 0/10002) per pubkey', () => {
    const old = ev({ id: 'o', kind: 10002, pubkey: 'pk1', created_at: 1 });
    const fresh = ev({ id: 'n', kind: 10002, pubkey: 'pk1', created_at: 2 });
    const out = deduplicateAndSort([old, fresh]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('n');
  });

  it('tie-breaks equal created_at by lowest id (NIP-01)', () => {
    const x = ev({ id: 'zzz', kind: 0, pubkey: 'pk1', created_at: 5 });
    const y = ev({ id: 'aaa', kind: 0, pubkey: 'pk1', created_at: 5 });
    const out = deduplicateAndSort([x, y]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('aaa');
  });
});

describe('replaceableCoordinate', () => {
  it('returns null for regular/ephemeral kinds', () => {
    expect(replaceableCoordinate(ev({ id: 'a', kind: 1 }))).toBeNull();
    expect(replaceableCoordinate(ev({ id: 'a', kind: 20000 }))).toBeNull();
  });
  it('uses kind:pubkey for replaceable, kind:pubkey:d for addressable', () => {
    expect(replaceableCoordinate(ev({ id: 'a', kind: 10002, pubkey: 'pk' }))).toBe('10002:pk');
    expect(replaceableCoordinate(ev({ id: 'a', kind: 30023, pubkey: 'pk', tags: [['d', 'x']] }))).toBe('30023:pk:x');
  });
});

describe('mergeEvents', () => {
  it('returns the same reference when nothing new by id', () => {
    const existing = [ev({ id: 'a', kind: 1 })];
    expect(mergeEvents(existing, [{ ...existing[0] }])).toBe(existing);
  });

  it('supersedes a stale addressable revision already present (H2)', () => {
    const stale = ev({ id: 'old', kind: 30023, pubkey: 'pk1', created_at: 1, tags: [['d', 'p']] });
    const fresh = ev({ id: 'new', kind: 30023, pubkey: 'pk1', created_at: 9, tags: [['d', 'p']] });
    const out = mergeEvents([stale], [fresh]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('new');
  });
});
