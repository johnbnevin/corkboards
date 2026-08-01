import { describe, it, expect } from 'vitest';
import { MissCache } from './missCache';

describe('MissCache.isExhausted', () => {
  it('is false for unknown keys and keys with attempts remaining', () => {
    const now = 0;
    const cache = new MissCache({ maxAttempts: 3, now: () => now });
    expect(cache.isExhausted('a')).toBe(false);
    cache.recordMiss('a');
    cache.recordMiss('a');
    expect(cache.isExhausted('a')).toBe(false);
  });

  it('ignores the cooldown: a fresh miss is not exhausted even though shouldRetry says wait', () => {
    const now = 0;
    const cache = new MissCache({ baseCooldownMs: 30_000, maxAttempts: 3, now: () => now });
    cache.recordMiss('a');
    // Inside the cooldown the periodic retry must wait…
    expect(cache.shouldRetry('a')).toBe(false);
    // …but an escalation pass with fresh evidence may still proceed.
    expect(cache.isExhausted('a')).toBe(false);
  });

  it('is true once the attempt budget is spent, and clears on a hit', () => {
    const now = 0;
    const cache = new MissCache({ maxAttempts: 2, now: () => now });
    cache.recordMiss('a');
    cache.recordMiss('a');
    expect(cache.isExhausted('a')).toBe(true);
    cache.recordHit('a');
    expect(cache.isExhausted('a')).toBe(false);
  });
});
