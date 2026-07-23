import { describe, it, expect } from 'vitest';
import {
  KNOWN_BLOSSOM_SERVERS,
  extractBlossomRef,
  getBlossomUrlsForHash,
  getBlossomFallbackUrls,
  parseImetaTag,
  resolveMediaSources,
} from '@core/blossom';

const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

describe('extractBlossomRef', () => {
  it('parses flat and nested content-addressed paths, rejects non-hash tails', () => {
    expect(extractBlossomRef(`https://blossom.band/${HASH}.png`)).toEqual({ hash: HASH, ext: '.png' });
    expect(extractBlossomRef(`https://file.nostrmedia.com/p/${HASH2}/${HASH}.mp4`)).toEqual({ hash: HASH, ext: '.mp4' });
    expect(extractBlossomRef('https://cdn.host/photo.png')).toBeNull();
    expect(extractBlossomRef(`http://blossom.band/${HASH}.png`)).toBeNull();
  });
});

describe('getBlossomUrlsForHash', () => {
  it('builds one URL per server for a valid hash', () => {
    const urls = getBlossomUrlsForHash(HASH, '.png');
    expect(urls).toHaveLength(KNOWN_BLOSSOM_SERVERS.length);
    expect(urls[0]).toBe(`https://blossom.band/${HASH}.png`);
  });

  it('normalizes an extension without a leading dot', () => {
    expect(getBlossomUrlsForHash(HASH, 'jpg')[0]).toBe(`https://blossom.band/${HASH}.jpg`);
  });

  it('handles an empty extension', () => {
    expect(getBlossomUrlsForHash(HASH, '')[0]).toBe(`https://blossom.band/${HASH}`);
  });

  it('returns [] for an invalid hash', () => {
    expect(getBlossomUrlsForHash('not-a-hash', '.png')).toEqual([]);
    expect(getBlossomUrlsForHash('abc', '')).toEqual([]);
  });
});

describe('getBlossomFallbackUrls (refactor regression guard)', () => {
  it('remaps a flat blossom URL to every OTHER known server', () => {
    const primary = `https://blossom.band/${HASH}.png`;
    const fallbacks = getBlossomFallbackUrls(primary);
    expect(fallbacks).toHaveLength(KNOWN_BLOSSOM_SERVERS.length - 1);
    expect(fallbacks).not.toContain(primary);
    expect(fallbacks).toContain(`https://blossom.primal.net/${HASH}.png`);
  });

  it('returns [] for a nested / non-content-addressed URL', () => {
    expect(getBlossomFallbackUrls('https://image.nostr.build/abc/def.png')).toEqual([]);
    expect(getBlossomFallbackUrls('https://cdn.host/photo.png')).toEqual([]);
  });

  it('remaps a NESTED content-addressed URL (nostrmedia-style) via its trailing hash', () => {
    // file.nostrmedia.com serves blobs at /p/<pubkey>/<sha256>.<ext> — the final
    // segment is the blob hash, so the same blob can be retried on Blossom servers.
    const primary = `https://file.nostrmedia.com/p/${HASH2}/${HASH}.mp4`;
    const fallbacks = getBlossomFallbackUrls(primary);
    expect(fallbacks).toHaveLength(KNOWN_BLOSSOM_SERVERS.length);
    expect(fallbacks).toContain(`https://blossom.band/${HASH}.mp4`);
    // the hash comes from the LAST segment, not the pubkey segment
    expect(fallbacks).not.toContain(`https://blossom.band/${HASH2}.mp4`);
  });
});

describe('parseImetaTag', () => {
  it('parses url, x, m, image and multiple fallbacks', () => {
    const data = parseImetaTag([
      'imeta',
      `url https://blossom.band/${HASH}.png`,
      `x ${HASH}`,
      'm image/png',
      'image https://blossom.band/poster.png',
      `fallback https://nostr.download/${HASH}.png`,
      `fallback https://cdn.sovbit.host/${HASH}.png`,
    ]);
    expect(data).toEqual({
      url: `https://blossom.band/${HASH}.png`,
      sha256: HASH,
      mime: 'image/png',
      image: 'https://blossom.band/poster.png',
      fallbacks: [
        `https://nostr.download/${HASH}.png`,
        `https://cdn.sovbit.host/${HASH}.png`,
      ],
    });
  });

  it('rejects a malformed x (sha256) value but keeps the url', () => {
    const data = parseImetaTag(['imeta', `url https://x/${HASH}.png`, 'x deadbeef']);
    expect(data?.sha256).toBeUndefined();
    expect(data?.url).toBe(`https://x/${HASH}.png`);
  });

  it('returns null without a url and for non-imeta tags', () => {
    expect(parseImetaTag(['imeta', `x ${HASH}`])).toBeNull();
    expect(parseImetaTag(['e', 'abc'])).toBeNull();
  });
});

describe('resolveMediaSources', () => {
  it('reconstructs across all servers from sha256 even for a NESTED primary URL', () => {
    // The core bug fix: a non-flat primary URL used to have zero fallback.
    const sources = resolveMediaSources({
      url: 'https://image.nostr.build/aa/bb.png',
      sha256: HASH,
      ext: '.png',
    });
    expect(sources[0]).toBe('https://image.nostr.build/aa/bb.png');
    // every known server's hash URL is present
    for (const base of KNOWN_BLOSSOM_SERVERS) {
      expect(sources).toContain(`${base.replace(/\/+$/, '')}/${HASH}.png`);
    }
  });

  it('for an old flat note without sha256, equals [url, ...getBlossomFallbackUrls(url)]', () => {
    const url = `https://blossom.band/${HASH}.png`;
    expect(resolveMediaSources({ url })).toEqual([url, ...getBlossomFallbackUrls(url)]);
  });

  it('dedups an author fallback that equals a reconstructed URL', () => {
    const url = `https://image.nostr.build/x/y.png`;
    const dupe = `https://nostr.download/${HASH}.png`;
    const sources = resolveMediaSources({ url, sha256: HASH, ext: '.png', fallbacks: [dupe] });
    expect(sources.filter((s) => s === dupe)).toHaveLength(1);
  });

  it('drops SSRF/private-host candidates', () => {
    const sources = resolveMediaSources({
      url: 'https://192.168.1.10/evil.png',
      fallbacks: ['http://localhost/x.png'],
      sha256: HASH,
      ext: '.png',
    });
    expect(sources).not.toContain('https://192.168.1.10/evil.png');
    expect(sources).not.toContain('http://localhost/x.png');
    // but the safe reconstructed known-server URLs remain
    expect(sources).toContain(`https://blossom.band/${HASH}.png`);
  });

  it('avatar rejectType drops non-https candidates', () => {
    const sources = resolveMediaSources({
      url: `http://blossom.band/${HASH}.png`,
      sha256: HASH,
      ext: '.png',
      rejectType: 'avatar',
    });
    expect(sources).not.toContain(`http://blossom.band/${HASH}.png`);
    expect(sources).toContain(`https://blossom.band/${HASH}.png`);
  });

  it('derives ext from the primary URL when not given', () => {
    const url = `https://image.nostr.build/x/y.webp`;
    // no ext, but a flat fallback carries it
    const sources = resolveMediaSources({ url, sha256: HASH, fallbacks: [`https://x/${HASH}.gif`] });
    // ext derived from primary (none) → falls to fallback's .gif
    expect(sources.some((s) => s === `https://blossom.band/${HASH}.gif`)).toBe(true);
  });
});
