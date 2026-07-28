import { describe, it, expect } from 'vitest';
import { extractHashtags, buildHashtagTags } from './hashtagTags';

describe('extractHashtags', () => {
  it('finds plain hashtags, lowercased and de-duplicated', () => {
    expect(extractHashtags('#Bitcoin and #bitcoin and #Nostr')).toEqual(['bitcoin', 'nostr']);
  });

  it('ignores fragments inside URLs — the bug that polluted hashtag feeds', () => {
    // Composers append uploaded image URLs to the body before scanning it.
    expect(extractHashtags('look https://host/pic.png#anchor')).toEqual([]);
    expect(extractHashtags('see https://example.com/post#section for #context')).toEqual(['context']);
  });

  it('ignores nostr: URIs', () => {
    expect(extractHashtags('nostr:nevent1abc123 #real')).toEqual(['real']);
  });

  it('matches non-Latin scripts', () => {
    expect(extractHashtags('#биткоин #比特币 #ビットコイン')).toEqual(['биткоин', '比特币', 'ビットコイン']);
  });

  it('accepts digit-leading tags that contain a letter', () => {
    // Real tags that a leading-letter rule silently dropped.
    expect(extractHashtags('#21million #100daysofcode')).toEqual([
      '21million', '100daysofcode',
    ]);
    expect(extractHashtags('#a1 #b2c')).toEqual(['a1', 'b2c']);
  });

  it('rejects pure-digit runs, which are numbering rather than topics', () => {
    expect(extractHashtags('#2 of 5, item #100')).toEqual([]);
    expect(extractHashtags('see #1 and #42')).toEqual([]);
    // Consequence worth pinning: a bare year is indistinguishable from a count,
    // so `#2140` is not a hashtag either. Write `#bitcoin2140` to tag a year.
    expect(extractHashtags('#2140')).toEqual([]);
  });
});

describe('buildHashtagTags', () => {
  it('produces publishable t tags', () => {
    expect(buildHashtagTags('#Nostr rules')).toEqual([['t', 'nostr']]);
  });

  it('produces nothing for content whose only # is in a link', () => {
    expect(buildHashtagTags('https://a.b/c#d')).toEqual([]);
  });
});
