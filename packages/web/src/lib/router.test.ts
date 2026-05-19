/**
 * Tests for the relay router abstraction in @core/router.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreToWeight,
  decayScore,
  recordHit,
  recordMiss,
  selectRelays,
  groupAuthorsByRelay,
  DEFAULT_ROUTER_CONFIG,
  type RelayScore,
  type RouterConfig,
} from '@core/router';

const CONFIG: RouterConfig = {
  ...DEFAULT_ROUTER_CONFIG,
  fallbacks: ['wss://fallback1', 'wss://fallback2'],
  indexers: ['wss://indexer1'],
  readOnly: ['wss://read-only'],
  maxRelaysPerQuery: 3,
};

describe('scoring', () => {
  it('unknown relay scores at 0.5 (neutral)', () => {
    expect(scoreToWeight({ hits: 0, misses: 0, touched: 0 })).toBe(0.5);
  });

  it('all-hits scores 1.0', () => {
    expect(scoreToWeight({ hits: 10, misses: 0, touched: 0 })).toBe(1);
  });

  it('all-misses scores 0', () => {
    expect(scoreToWeight({ hits: 0, misses: 10, touched: 0 })).toBe(0);
  });

  it('decay erodes both hits and misses proportionally', () => {
    const fresh: RelayScore = { hits: 8, misses: 2, touched: 0 };
    const decayed = decayScore(fresh, 1000, 1000); // exactly one half-life later
    expect(decayed.hits).toBeCloseTo(4, 5);
    expect(decayed.misses).toBeCloseTo(1, 5);
    expect(decayed.touched).toBe(1000);
  });

  it('recordHit/recordMiss create fresh scores', () => {
    expect(recordHit(undefined, 100)).toEqual({ hits: 1, misses: 0, touched: 100 });
    expect(recordMiss(undefined, 100)).toEqual({ hits: 0, misses: 1, touched: 100 });
  });
});

describe('selectRelays', () => {
  it('respects maxRelaysPerQuery', () => {
    const candidates = ['wss://a', 'wss://b', 'wss://c', 'wss://d', 'wss://e'];
    const picked = selectRelays({
      scenario: 'read-follows',
      candidates,
      scores: new Map(),
      config: CONFIG,
    });
    expect(picked.length).toBe(3);
  });

  it('filters out read-only relays for write scenarios', () => {
    const candidates = ['wss://a', 'wss://read-only', 'wss://b'];
    const picked = selectRelays({
      scenario: 'write-outbox',
      candidates,
      scores: new Map(),
      config: CONFIG,
    });
    expect(picked).not.toContain('wss://read-only');
  });

  it('keeps read-only relays for read scenarios', () => {
    const candidates = ['wss://read-only'];
    const picked = selectRelays({
      scenario: 'read-follows',
      candidates,
      scores: new Map(),
      config: CONFIG,
    });
    expect(picked).toContain('wss://read-only');
  });

  it('ranks high-scoring relays first', () => {
    const scores = new Map<string, RelayScore>([
      ['wss://good', { hits: 10, misses: 0, touched: Date.now() }],
      ['wss://bad', { hits: 0, misses: 10, touched: Date.now() }],
    ]);
    const picked = selectRelays({
      scenario: 'read-follows',
      candidates: ['wss://bad', 'wss://good'],
      scores,
      config: CONFIG,
    });
    expect(picked[0]).toBe('wss://good');
  });

  it('falls back to fallback relays for read scenarios with empty candidates', () => {
    const picked = selectRelays({
      scenario: 'read-follows',
      candidates: [],
      scores: new Map(),
      config: CONFIG,
    });
    expect(picked).toContain('wss://fallback1');
  });

  it('does NOT add fallbacks for write-outbox (must publish only to author relays)', () => {
    const picked = selectRelays({
      scenario: 'write-outbox',
      candidates: [],
      scores: new Map(),
      config: CONFIG,
    });
    expect(picked).toEqual([]);
  });
});

describe('groupAuthorsByRelay', () => {
  it('groups authors by their published write relays', () => {
    const authorRelays = new Map<string, readonly string[]>([
      ['alice', ['wss://r1', 'wss://r2']],
      ['bob', ['wss://r2', 'wss://r3']],
    ]);
    const groups = groupAuthorsByRelay(['alice', 'bob'], authorRelays, []);
    expect(groups.get('wss://r1')).toEqual(['alice']);
    expect(groups.get('wss://r2')).toEqual(['alice', 'bob']);
    expect(groups.get('wss://r3')).toEqual(['bob']);
  });

  it('falls back to provided fallbacks for unknown authors', () => {
    const groups = groupAuthorsByRelay(['unknown'], new Map(), ['wss://fb']);
    expect(groups.get('wss://fb')).toEqual(['unknown']);
  });

  it('handles authors with zero published relays via fallback', () => {
    const authorRelays = new Map<string, readonly string[]>([['alice', []]]);
    const groups = groupAuthorsByRelay(['alice'], authorRelays, ['wss://fb']);
    expect(groups.get('wss://fb')).toEqual(['alice']);
  });
});
