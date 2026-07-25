/**
 * Caching in the feed's hot classifiers.
 *
 * `getNoteCategories` and the hashtag extractors run several times per note per
 * feed recompute — filtering, chip counts, kind stats — and for reposts they
 * JSON-parse the embedded event each time. These pin both halves of the
 * contract: results are reused, AND caching doesn't freeze an answer that was
 * still waiting on data.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import {
  getNoteCategories,
  getNoteHashtags,
  getRepostHashtags,
} from '@core/noteCategories';

let seq = 0;
/** Each call returns a distinct object, so the WeakMap can't cross-contaminate. */
function ev(partial: Partial<NostrEvent>): NostrEvent {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, '0'),
    pubkey: '1'.repeat(64), created_at: 0,
    kind: 1, content: '', sig: '', tags: [], ...partial,
  } as NostrEvent;
}

afterEach(() => vi.restoreAllMocks());

describe('getNoteCategories caching', () => {
  it('returns the identical Set on a repeat call for the same event', () => {
    const note = ev({ content: 'plain text' });
    expect(getNoteCategories(note)).toBe(getNoteCategories(note));
  });

  it('does not parse a repost body twice', () => {
    const embedded = ev({ content: 'original' });
    const repost = ev({ kind: 6, content: JSON.stringify(embedded) });
    const parse = vi.spyOn(JSON, 'parse');
    getNoteCategories(repost);
    const afterFirst = parse.mock.calls.length;
    getNoteCategories(repost);
    expect(parse.mock.calls.length).toBe(afterFirst);
  });

  it('keeps distinct events distinct', () => {
    const text = ev({ content: 'words' });
    const image = ev({ content: 'https://i.nostr.build/a.jpg' });
    expect([...getNoteCategories(text)]).toEqual(['shortNotes']);
    expect(getNoteCategories(image).has('images')).toBe(true);
  });

  it('re-resolves a reaction whose target was missing the first time', () => {
    const target = ev({ content: 'https://i.nostr.build/a.jpg' });
    const reaction = ev({ kind: 7, content: '+', tags: [['e', target.id]] });

    // First pass: the target hasn't loaded yet, so all we know is "reaction".
    const before = getNoteCategories(reaction, new Map());
    expect(before.has('images')).toBe(false);

    // Once the target arrives the answer must change — a cached "unresolved"
    // verdict here is exactly how a note gets stuck in the wrong filter bucket.
    const after = getNoteCategories(reaction, new Map([[target.id, target]]));
    expect(after.has('images')).toBe(true);
    expect(after.has('reactions')).toBe(true);
  });

  it('stops recomputing once the target has been resolved', () => {
    const target = ev({ content: 'https://i.nostr.build/a.jpg' });
    const reaction = ev({ kind: 7, content: '+', tags: [['e', target.id]] });
    const lookup = new Map([[target.id, target]]);
    expect(getNoteCategories(reaction, lookup)).toBe(getNoteCategories(reaction, lookup));
  });
});

describe('hashtag extraction caching', () => {
  it('reuses the extracted set for a note', () => {
    const note = ev({ content: 'hello #nostr', tags: [['t', 'bitcoin']] });
    const first = getNoteHashtags(note);
    expect(getNoteHashtags(note)).toBe(first);
    expect([...first].sort()).toEqual(['bitcoin', 'nostr']);
  });

  it('reuses the extracted set for a repost', () => {
    const embedded = ev({ content: 'a post about #nostr' });
    const repost = ev({ kind: 6, content: JSON.stringify(embedded) });
    const first = getRepostHashtags(repost);
    expect(getRepostHashtags(repost)).toBe(first);
    expect([...first]).toEqual(['nostr']);
  });

  it('does not retry parsing a repost body that failed once', () => {
    const broken = ev({ kind: 6, content: '{not json' });
    expect([...getRepostHashtags(broken)]).toEqual([]);
    const parse = vi.spyOn(JSON, 'parse');
    expect([...getRepostHashtags(broken)]).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });
});
