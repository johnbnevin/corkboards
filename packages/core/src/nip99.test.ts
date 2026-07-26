import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { parseListing } from './nip99';

function ev(tags: string[][]): NostrEvent {
  return { id: 'x'.repeat(64), pubkey: 'a'.repeat(64), created_at: 0, kind: 30402, tags, content: '', sig: '' };
}

describe('nip99 parseListing image ordering', () => {
  it('orders images by the numeric Gamma order field', () => {
    const l = parseListing(ev([['image', 'b', '', '2'], ['image', 'a', '', '1']]));
    expect(l.images).toEqual(['a', 'b']);
  });

  it('stays well-defined when an order field is non-numeric (no NaN comparator)', () => {
    // 'oops' -> NaN under the old comparator, which is undefined-behavior sort.
    const l = parseListing(ev([['image', 'a', '', 'oops'], ['image', 'b', '', '1'], ['image', 'c']]));
    expect([...l.images].sort()).toEqual(['a', 'b', 'c']); // all present, no throw/garble
  });
});
