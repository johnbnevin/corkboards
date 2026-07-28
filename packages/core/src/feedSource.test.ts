import { describe, it, expect } from 'vitest';
import { parseFeedSource } from './feedSource';

// Stand-in decoder: 'npub1valid' -> a fixed hex pubkey; everything else null.
const HEX = 'a'.repeat(64);
const decode = (s: string) => (s === 'npub1valid' ? HEX : null);

describe('parseFeedSource', () => {
  it('classifies hashtags (lowercased, # stripped)', () => {
    expect(parseFeedSource('#Bitcoin', decode)).toEqual({ type: 'hashtag', value: 'bitcoin' });
  });
  it('classifies non-Latin hashtags', () => {
    // `\w` is ASCII-only; these were rejected before the class went Unicode.
    expect(parseFeedSource('#биткоин', decode)).toEqual({ type: 'hashtag', value: 'биткоин' });
    expect(parseFeedSource('#比特币', decode)).toEqual({ type: 'hashtag', value: '比特币' });
    expect(parseFeedSource('#ビットコイン', decode)).toEqual({ type: 'hashtag', value: 'ビットコイン' });
  });
  it('rejects a hashtag containing punctuation or spaces', () => {
    expect(parseFeedSource('#not a tag', decode)).toBeNull();
    expect(parseFeedSource('#tag!', decode)).toBeNull();
  });
  it('classifies relays', () => {
    expect(parseFeedSource('wss://relay.example', decode)).toEqual({ type: 'relay', value: 'wss://relay.example' });
  });
  it('classifies https RSS as-is and upgrades http', () => {
    expect(parseFeedSource('https://ex.com/feed', decode)).toEqual({ type: 'rss', value: 'https://ex.com/feed' });
    expect(parseFeedSource('http://ex.com/feed', decode)).toEqual({ type: 'rss', value: 'https://ex.com/feed', httpsUpgraded: true });
  });
  it('treats a bare domain as an RSS URL', () => {
    expect(parseFeedSource('example.com/rss', decode)).toEqual({ type: 'rss', value: 'https://example.com/rss' });
  });
  it('decodes an npub to a hex pubkey via the injected decoder', () => {
    expect(parseFeedSource('npub1valid', decode)).toEqual({ type: 'pubkey', value: HEX });
  });
  it('accepts a bare 64-hex pubkey', () => {
    expect(parseFeedSource(HEX, decode)).toEqual({ type: 'pubkey', value: HEX });
  });
  it('returns null for empty / unrecognized input', () => {
    expect(parseFeedSource('   ', decode)).toBeNull();
    expect(parseFeedSource('just some words', decode)).toBeNull();
  });
});
