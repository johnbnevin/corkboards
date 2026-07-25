/**
 * Media identity — the key that answers "is this the same picture?".
 *
 * `canonicalMediaUrl` still keys on the host, so a blob mirrored to a second
 * Blossom server reads as a different file and the note renders it twice. That
 * is the common case now that uploads are mirrored for redundancy, and it is
 * what this key exists to collapse.
 */
import { describe, it, expect } from 'vitest';
import { mediaIdentityKey } from '@core/blossom';
import { canonicalMediaUrl } from '@core/sanitizeUtils';

const HASH = 'd'.repeat(64);
const key = (url: string, sha?: string) => mediaIdentityKey(url, canonicalMediaUrl(url), sha);

describe('mediaIdentityKey', () => {
  it('collapses the same blob mirrored across Blossom servers', () => {
    expect(key(`https://blossom.band/${HASH}.jpg`))
      .toBe(key(`https://cdn.satellite.earth/${HASH}.jpg`));
  });

  it('collapses across differing file extensions on the same blob', () => {
    expect(key(`https://blossom.band/${HASH}.jpg`))
      .toBe(key(`https://blossom.band/${HASH}`));
  });

  it('matches a hashed content URL against an imeta tag that declares the hash', () => {
    expect(key(`https://blossom.band/${HASH}.png`))
      .toBe(key('https://some.cdn.example/uploads/pic.png', HASH));
  });

  it('accepts an uppercase sha256 from imeta and normalizes it', () => {
    expect(key('https://a.example/x.png', HASH.toUpperCase()))
      .toBe(key('https://b.example/y.png', HASH));
  });

  it('falls back to the canonical URL when no hash is available', () => {
    expect(key('https://www.Example.com/a.jpg')).toBe(key('http://example.com/a.jpg/'));
    expect(key('https://example.com/a.jpg')).not.toBe(key('https://example.com/b.jpg'));
  });

  it('keeps genuinely different blobs apart', () => {
    const other = 'e'.repeat(64);
    expect(key(`https://blossom.band/${HASH}.jpg`))
      .not.toBe(key(`https://blossom.band/${other}.jpg`));
  });

  it('ignores a malformed sha256 rather than keying everything to the same value', () => {
    expect(key('https://a.example/one.jpg', 'not-a-hash'))
      .not.toBe(key('https://b.example/two.jpg', 'not-a-hash'));
  });
});
