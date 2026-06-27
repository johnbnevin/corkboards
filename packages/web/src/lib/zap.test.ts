import { describe, it, expect } from 'vitest';
import { resolveZapEndpoint, lud16ToLnurlPayUrl, lud06ToLnurlPayUrl, isSafeZapUrl } from '@core/zap';

describe('zap endpoint resolution', () => {
  it('resolves a lud16 lightning address', () => {
    expect(lud16ToLnurlPayUrl('alice@getalby.com')).toBe(
      'https://getalby.com/.well-known/lnurlp/alice',
    );
  });

  it('lowercases the domain and trims whitespace on lud16', () => {
    expect(lud16ToLnurlPayUrl('  Bob@Example.COM ')).toBe(
      'https://example.com/.well-known/lnurlp/Bob',
    );
  });

  it('rejects malformed lud16', () => {
    expect(lud16ToLnurlPayUrl('not-an-address')).toBeNull();
    expect(lud16ToLnurlPayUrl('@nodomain')).toBeNull();
    expect(lud16ToLnurlPayUrl('name@nodot')).toBeNull();
    expect(lud16ToLnurlPayUrl('name@bad/domain.com')).toBeNull();
  });

  it('decodes a lud06 bech32 LNURL (canonical LUD-06 vector)', () => {
    const lnurl =
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
    expect(lud06ToLnurlPayUrl(lnurl)).toBe(
      'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df',
    );
    // Lowercase form must decode identically.
    expect(lud06ToLnurlPayUrl(lnurl.toLowerCase())).toBe(
      'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df',
    );
  });

  it('rejects non-LNURL bech32 and garbage', () => {
    expect(lud06ToLnurlPayUrl('notlnurl')).toBeNull();
    expect(lud06ToLnurlPayUrl('npub1xxx')).toBeNull();
    expect(lud06ToLnurlPayUrl('')).toBeNull();
  });

  it('prefers lud16 but falls back to lud06', () => {
    const lnurl =
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
    expect(resolveZapEndpoint({ lud16: 'alice@getalby.com', lud06: lnurl })).toBe(
      'https://getalby.com/.well-known/lnurlp/alice',
    );
    // lud06-only profile — the case that previously looked like "no address".
    expect(resolveZapEndpoint({ lud06: lnurl })).toBe(
      'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df',
    );
  });

  it('tolerates a value placed in the wrong field', () => {
    const lnurl =
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
    // lnurl string sitting in the lud16 field
    expect(resolveZapEndpoint({ lud16: lnurl })).toContain('https://service.com/api');
    // address sitting in the lud06 field
    expect(resolveZapEndpoint({ lud06: 'alice@getalby.com' })).toBe(
      'https://getalby.com/.well-known/lnurlp/alice',
    );
  });

  it('returns null when no usable address is present', () => {
    expect(resolveZapEndpoint(null)).toBeNull();
    expect(resolveZapEndpoint({})).toBeNull();
    expect(resolveZapEndpoint({ lud16: '', lud06: '' })).toBeNull();
  });

  describe('SSRF host validation', () => {
    it('isSafeZapUrl accepts https public hosts, rejects private/loopback/http', () => {
      expect(isSafeZapUrl('https://getalby.com/.well-known/lnurlp/alice')).toBe(true);
      expect(isSafeZapUrl('http://getalby.com/x')).toBe(false); // not https
      expect(isSafeZapUrl('https://127.0.0.1/x')).toBe(false); // loopback
      expect(isSafeZapUrl('https://169.254.169.254/latest/meta-data')).toBe(false); // metadata
      expect(isSafeZapUrl('https://10.0.0.5/x')).toBe(false); // private
      expect(isSafeZapUrl('https://localhost/x')).toBe(false);
      expect(isSafeZapUrl('https://[::1]/x')).toBe(false); // ipv6 loopback
      expect(isSafeZapUrl('not a url')).toBe(false);
    });

    it('rejects a lud16 pointing at an IP-literal / private host', () => {
      expect(lud16ToLnurlPayUrl('x@127.0.0.1')).toBeNull();
      expect(lud16ToLnurlPayUrl('x@169.254.169.254')).toBeNull();
      expect(resolveZapEndpoint({ lud16: 'x@10.0.0.1' })).toBeNull();
    });
  });
});
