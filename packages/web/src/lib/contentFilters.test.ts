/**
 * "Hide notes with:" predicate.
 *
 * Two reported problems drive these cases:
 *  - the text field did nothing, because it compared a note's ENTIRE content
 *    for equality (and only for kinds 1 and 7), which essentially never matches;
 *  - the same panel on mobile was wired to nothing at all.
 * Both now run this one predicate.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import {
  noteMatchesContentFilters,
  hasActiveContentFilters,
  type ContentFilterConfig,
} from '@core/contentFilters';

const OFF: ContentFilterConfig = {
  hideMinChars: 0,
  hideOnlyEmoji: false,
  hideOnlyMedia: false,
  hideOnlyLinks: false,
  hideMarkdown: false,
  hideHtml: false,
  hideExactText: '',
  allowPV: false,
  allowGM: false,
  allowGN: false,
  allowEyes: false,
  allow100: false,
};

function ev(partial: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'f'.repeat(64), pubkey: '1'.repeat(64), created_at: 0,
    kind: 1, content: '', sig: '', tags: [], ...partial,
  } as NostrEvent;
}

/** Mirrors the caller: hideExactText is trimmed + lowercased once per feed pass. */
const keep = (note: NostrEvent, cfg: Partial<ContentFilterConfig> = {}) => {
  const config = { ...OFF, ...cfg };
  return noteMatchesContentFilters(note, config, config.hideExactText.trim().toLowerCase());
};

describe('text filter', () => {
  it('hides a note that contains the phrase anywhere', () => {
    expect(keep(ev({ content: 'hello world, good morning' }), { hideExactText: 'good morning' })).toBe(false);
  });

  it('is case-insensitive and ignores surrounding whitespace in the query', () => {
    expect(keep(ev({ content: 'GOOD Morning' }), { hideExactText: '  good morning  ' })).toBe(false);
  });

  it('still hides a note whose whole content is the phrase — the old behaviour, subsumed', () => {
    expect(keep(ev({ content: 'gm' }), { hideExactText: 'gm' })).toBe(false);
  });

  it('leaves notes that do not contain the phrase', () => {
    expect(keep(ev({ content: 'good evening' }), { hideExactText: 'good morning' })).toBe(true);
  });

  it('applies to kinds beyond 1 and 7 — an article carrying the phrase goes too', () => {
    const article = ev({ kind: 30023, content: 'body', tags: [['title', 'Good Morning Everyone']] });
    expect(keep(article, { hideExactText: 'good morning' })).toBe(false);
  });

  it('reads a repost through to the embedded note rather than its JSON wrapper', () => {
    const repost = ev({ kind: 6, content: JSON.stringify(ev({ content: 'good morning' })) });
    expect(keep(repost, { hideExactText: 'good morning' })).toBe(false);
    // ...and does not match on JSON structure the reader never sees.
    expect(keep(repost, { hideExactText: 'created_at' })).toBe(true);
  });

  it('is not overridden by the always-show exceptions', () => {
    // The exceptions rescue from the shape filters; an explicit text match wins.
    expect(keep(ev({ content: '🌅' }), { hideExactText: '🌅', allowGM: true })).toBe(false);
  });

  it('does nothing when the field is blank or whitespace', () => {
    expect(keep(ev({ content: 'anything' }), { hideExactText: '   ' })).toBe(true);
  });
});

describe('shape filters', () => {
  it('hides emoji-only notes', () => {
    expect(keep(ev({ content: '🎉🎉' }), { hideOnlyEmoji: true })).toBe(false);
    expect(keep(ev({ content: 'nice 🎉' }), { hideOnlyEmoji: true })).toBe(true);
  });

  it('hides link-only notes', () => {
    expect(keep(ev({ content: 'https://example.com' }), { hideOnlyLinks: true })).toBe(false);
    expect(keep(ev({ content: 'see https://example.com' }), { hideOnlyLinks: true })).toBe(true);
  });

  it('hides media-only notes', () => {
    expect(keep(ev({ content: 'https://x.example/a.jpg' }), { hideOnlyMedia: true })).toBe(false);
    expect(keep(ev({ content: 'look https://x.example/a.jpg' }), { hideOnlyMedia: true })).toBe(true);
  });

  it('hides short notes at or under the threshold, but not empty ones', () => {
    expect(keep(ev({ content: 'hi' }), { hideMinChars: 5 })).toBe(false);
    expect(keep(ev({ content: 'long enough' }), { hideMinChars: 5 })).toBe(true);
    expect(keep(ev({ content: '   ' }), { hideMinChars: 5 })).toBe(true);
  });

  it('hides markdown and HTML when asked', () => {
    expect(keep(ev({ content: '# heading' }), { hideMarkdown: true })).toBe(false);
    expect(keep(ev({ content: '<b>bold</b>' }), { hideHtml: true })).toBe(false);
  });

  it('does not apply to kinds other than notes and reactions', () => {
    // An article is not "an emoji-only post" no matter what its body looks like.
    expect(keep(ev({ kind: 30023, content: '🎉' }), { hideOnlyEmoji: true })).toBe(true);
  });
});

describe('always-show exceptions', () => {
  it('rescues a GM note from the emoji-only filter', () => {
    expect(keep(ev({ content: '🌅' }), { hideOnlyEmoji: true })).toBe(false);
    expect(keep(ev({ content: '🌅' }), { hideOnlyEmoji: true, allowGM: true })).toBe(true);
  });

  it('rescues from the character threshold too', () => {
    expect(keep(ev({ content: '👀' }), { hideMinChars: 10, allowEyes: true })).toBe(true);
  });

  it('does not rescue an unrelated emoji', () => {
    expect(keep(ev({ content: '🎉' }), { hideOnlyEmoji: true, allowGM: true })).toBe(false);
  });
});

describe('hasActiveContentFilters', () => {
  it('is false when everything is off', () => {
    expect(hasActiveContentFilters(OFF)).toBe(false);
  });

  it('does not count a whitespace-only text field as active', () => {
    expect(hasActiveContentFilters({ ...OFF, hideExactText: '   ' })).toBe(false);
  });

  it('is true for any engaged control', () => {
    expect(hasActiveContentFilters({ ...OFF, hideMinChars: 1 })).toBe(true);
    expect(hasActiveContentFilters({ ...OFF, hideOnlyEmoji: true })).toBe(true);
    expect(hasActiveContentFilters({ ...OFF, hideHtml: true })).toBe(true);
    expect(hasActiveContentFilters({ ...OFF, hideExactText: 'gm' })).toBe(true);
  });

  it('is not turned on by the always-show exceptions alone — they only relax', () => {
    expect(hasActiveContentFilters({ ...OFF, allowGM: true })).toBe(false);
  });
});
