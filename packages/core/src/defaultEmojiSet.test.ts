import { describe, it, expect } from 'vitest';
import {
  CORKBOARDS_DEFAULT_EMOJIS,
  defaultEmojiChar,
  twemojiCharFromUrl,
} from './defaultEmojiSet';

describe('twemojiCharFromUrl', () => {
  it('recovers the glyph from a twemoji asset filename', () => {
    expect(twemojiCharFromUrl('https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f600.png')).toBe('😀');
    expect(twemojiCharFromUrl('https://example.com/72x72/2764.png')).toBe('❤');
  });

  it('joins multi-codepoint sequences', () => {
    // Keycap digit one: U+0031 U+20E3.
    expect(twemojiCharFromUrl('https://example.com/72x72/0031-20e3.png')).toBe('1⃣');
  });

  it('returns null for anything that is not a twemoji PNG', () => {
    for (const url of [
      'https://i.nostr.build/O4gwQ.gif',
      'https://cdn.betterttv.net/emote/5b1740221c5a6065a7bad4b5/3x.webp',
      'https://example.com/nothex.png',
      '',
    ]) {
      expect(twemojiCharFromUrl(url)).toBeNull();
    }
  });
});

describe('defaultEmojiChar', () => {
  it('maps static default emoji to a native glyph so they never hit the CDN', () => {
    expect(defaultEmojiChar('cb-smile-open')).toBe('😀');
    expect(defaultEmojiChar('cb-lol-tears')).toBe('😂');
  });

  it('returns null for the custom animated emoji, which genuinely need their URL', () => {
    expect(defaultEmojiChar('cb-yeschad')).toBeNull();
    expect(defaultEmojiChar('cb-catrave')).toBeNull();
  });

  it('returns null for an unknown shortcode', () => {
    expect(defaultEmojiChar('cb-not-a-real-emoji')).toBeNull();
  });

  it('covers every jsdelivr-hosted entry, leaving no CDN fetch behind', () => {
    const cdnHosted = CORKBOARDS_DEFAULT_EMOJIS.filter((e) => e.url.includes('cdn.jsdelivr.net'));
    expect(cdnHosted.length).toBeGreaterThan(0);
    for (const { shortcode } of cdnHosted) {
      expect(defaultEmojiChar(shortcode), shortcode).not.toBeNull();
    }
  });
});
