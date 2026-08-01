import { describe, it, expect } from 'vitest';
import { genUserName } from './genUserName';

describe('genUserName', () => {
  it('generates a deterministic name from a seed', () => {
    const seed = 'test-seed-123';
    const name1 = genUserName(seed);
    const name2 = genUserName(seed);

    expect(name1).toEqual(name2);
  });

  it('generates "Adjective Animal" pet names, never key fragments', () => {
    const pubkey = 'e4690a13290739da123aa17d553851dec4cdd0e9d89aa18de3741c446caf8761';
    const name = genUserName(pubkey);

    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(name).not.toContain('user_');
    expect(name).not.toContain(pubkey.slice(0, 8));
  });

  it('generates different names for different seeds', () => {
    const name1 = genUserName('seed1xxx');
    const name2 = genUserName('seed2xxx');
    const name3 = genUserName('seed3xxx');

    expect(name1).not.toBe(name2);
    expect(name2).not.toBe(name3);
    expect(name1).not.toBe(name3);
  });

  it('spreads across the name space for realistic pubkeys', () => {
    // 50 distinct hex seeds should not funnel into a handful of names —
    // guards against a bit-range bug making every name "Agile Alpaca".
    const names = new Set(
      Array.from({ length: 50 }, (_, i) =>
        genUserName(i.toString(16).padStart(64, 'a'))),
    );
    expect(names.size).toBeGreaterThan(40);
  });
});
