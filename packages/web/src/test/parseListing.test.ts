import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { parseListing } from '@core/nip99';

function ev(tags: string[][], content = ''): NostrEvent {
  return { id: 'x'.repeat(64), pubkey: 'a'.repeat(64), created_at: 0, kind: 30402, tags, content, sig: '' };
}

describe('parseListing (NIP-99 + Gamma)', () => {
  it('extracts core NIP-99 fields', () => {
    const p = parseListing(ev([
      ['d', 'abc'],
      ['title', 'Vintage Chair'],
      ['summary', 'A nice chair'],
      ['price', '20', 'USD'],
      ['location', 'Austin, TX'],
      ['status', 'active'],
    ]));
    expect(p.title).toBe('Vintage Chair');
    expect(p.summary).toBe('A nice chair');
    expect(p.price).toBe('20 USD');
    expect(p.location).toBe('Austin, TX');
    expect(p.status).toBe('active');
  });

  it('formats a recurring price frequency', () => {
    expect(parseListing(ev([['price', '1000', 'sat', 'month']])).price).toBe('1000 sat/month');
  });

  it('orders Gamma image tags by the order field and falls back to imeta', () => {
    const p = parseListing(ev([
      ['image', 'https://c/2.jpg', '800x600', '2'],
      ['image', 'https://c/1.jpg', '800x600', '1'],
    ]));
    expect(p.images).toEqual(['https://c/1.jpg', 'https://c/2.jpg']);

    const imeta = parseListing(ev([['imeta', 'url https://c/p.jpg', 'm image/jpeg']]));
    expect(imeta.images).toEqual(['https://c/p.jpg']);
  });

  it('parses Gamma stock, visibility, and spec tags', () => {
    const p = parseListing(ev([
      ['title', 'T-Shirt'],
      ['stock', '5'],
      ['visibility', 'pre-order'],
      ['spec', 'color', 'red'],
      ['spec', 'size', 'L'],
    ]));
    expect(p.stock).toBe(5);
    expect(p.visibility).toBe('pre-order');
    expect(p.specs).toEqual([['color', 'red'], ['size', 'L']]);
  });

  it('treats non-numeric / missing stock as undefined', () => {
    expect(parseListing(ev([['title', 'x']])).stock).toBeUndefined();
    expect(parseListing(ev([['stock', 'lots']])).stock).toBeUndefined();
    expect(parseListing(ev([['stock', '0']])).stock).toBe(0);
  });
});
