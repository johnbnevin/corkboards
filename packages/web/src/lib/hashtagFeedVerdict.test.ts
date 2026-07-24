import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { hashtagFeedVerdict, MAX_TTAGS_WITHOUT_CONTENT_MATCH } from '@core/noteCategories';

/** Build a minimal kind-1 note with the given content and `t` tags. */
function note(content: string, tTags: string[] = [], kind = 1): NostrEvent {
  return {
    id: 'x'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    kind,
    content,
    tags: tTags.map(t => ['t', t]),
    sig: 'b'.repeat(128),
  } as NostrEvent;
}

describe('hashtagFeedVerdict', () => {
  it('returns "match" when the content mentions the hashtag inline', () => {
    expect(hashtagFeedVerdict(note('gm #nostr friends', ['nostr']), 'nostr')).toBe('match');
    // content mention wins even with many tags
    const stuffed = note('all about #bitcoin', Array.from({ length: 20 }, (_, i) => `t${i}`).concat('bitcoin'));
    expect(hashtagFeedVerdict(stuffed, 'bitcoin')).toBe('match');
  });

  it('normalizes case and a leading # on the query', () => {
    expect(hashtagFeedVerdict(note('hello #Nostr', ['nostr']), '#NOSTR')).toBe('match');
  });

  it('returns "tagged-only" when tagged but not mentioned and carrying only this one topic tag', () => {
    // NIP-24: a note may legitimately categorize a single topic via a `t` tag.
    expect(hashtagFeedVerdict(note('no hashtags here', ['art']), 'art')).toBe('tagged-only');
    expect(hashtagFeedVerdict(note('a calendar event', ['bitcoin']), 'bitcoin')).toBe('tagged-only');
  });

  it('treats a note with more than one topic tag but no inline mention as spam', () => {
    // Threshold is 1: any second topic tag on an unmentioned match reads as stuffing.
    expect(hashtagFeedVerdict(note('a calendar event', ['bitcoin', 'conference']), 'bitcoin')).toBe('spam');
  });

  it('returns "spam" when tagged but not mentioned and stuffed with many topic tags', () => {
    const many = Array.from({ length: MAX_TTAGS_WITHOUT_CONTENT_MATCH + 1 }, (_, i) => `topic${i}`);
    many.push('bitcoin');
    expect(hashtagFeedVerdict(note('buy my coin', many), 'bitcoin')).toBe('spam');
  });

  it('treats exactly the threshold count as tagged-only, one over as spam', () => {
    const atThreshold = Array.from({ length: MAX_TTAGS_WITHOUT_CONTENT_MATCH - 1 }, (_, i) => `t${i}`);
    atThreshold.push('bitcoin'); // total === threshold
    expect(hashtagFeedVerdict(note('no mention', atThreshold), 'bitcoin')).toBe('tagged-only');

    const overThreshold = Array.from({ length: MAX_TTAGS_WITHOUT_CONTENT_MATCH }, (_, i) => `t${i}`);
    overThreshold.push('bitcoin'); // total === threshold + 1
    expect(hashtagFeedVerdict(note('no mention', overThreshold), 'bitcoin')).toBe('spam');
  });

  it('returns "unrelated" when the note neither mentions nor carries the hashtag tag', () => {
    // e.g. an author note that landed in a mixed corkboard for other reasons.
    expect(hashtagFeedVerdict(note('just a normal post', ['cooking']), 'bitcoin')).toBe('unrelated');
    expect(hashtagFeedVerdict(note('no tags at all', []), 'bitcoin')).toBe('unrelated');
  });
});
