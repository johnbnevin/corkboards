/**
 * Tests for the relay scoring helpers in @core/router.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreToWeight,
  decayScore,
  recordHit,
  recordMiss,
  type RelayScore,
} from '@core/router';

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
