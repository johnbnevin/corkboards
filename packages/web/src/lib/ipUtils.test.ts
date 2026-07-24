/**
 * Tests for the SSRF / private-range host checks in @core/ipUtils, and the
 * URL guards in @core/imageUtils and @core/nostrUtils that depend on them.
 */
import { describe, it, expect } from 'vitest';
import { ipv4ToInt, isPrivateIPv4, isPrivateIPv6, isUnsafeHost } from '@core/ipUtils';
import { shouldRejectUrl, optimizeMediaUrl } from '@core/imageUtils';
import { isSecureRelay } from '@core/nostrUtils';
import { normalizeRelay } from '@core/normalizeRelay';

describe('ipv4ToInt', () => {
  it('parses canonical dotted-quad', () => {
    expect(ipv4ToInt('127.0.0.1')).toBe(0x7f000001);
    expect(ipv4ToInt('169.254.169.254')).toBe(0xa9fea9fe);
  });
  it('parses decimal-integer form', () => {
    expect(ipv4ToInt('2130706433')).toBe(0x7f000001); // 127.0.0.1
  });
  it('parses hex form', () => {
    expect(ipv4ToInt('0x7f000001')).toBe(0x7f000001);
  });
  it('parses octal form', () => {
    expect(ipv4ToInt('0177.0.0.1')).toBe(0x7f000001);
  });
  it('parses short form', () => {
    expect(ipv4ToInt('127.1')).toBe(0x7f000001);
  });
  it('returns null for hostnames', () => {
    expect(ipv4ToInt('example.com')).toBeNull();
    expect(ipv4ToInt('relay.damus.io')).toBeNull();
  });
});

describe('isPrivateIPv4', () => {
  it('flags loopback / RFC1918 / link-local / CGNAT', () => {
    expect(isPrivateIPv4(ipv4ToInt('127.0.0.1')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('10.1.2.3')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('192.168.1.1')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('172.16.0.1')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('169.254.169.254')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('100.64.0.1')!)).toBe(true);
  });
  // These ranges are also blocked server-side by rss-proxy.php's isBlockedIp();
  // the two lists are meant to stay identical, so test them the same way.
  it('flags the reserved ranges the RSS proxy also blocks', () => {
    expect(isPrivateIPv4(ipv4ToInt('192.0.0.1')!)).toBe(true);    // IETF protocol assignments
    expect(isPrivateIPv4(ipv4ToInt('192.0.2.5')!)).toBe(true);    // TEST-NET-1
    expect(isPrivateIPv4(ipv4ToInt('198.18.0.1')!)).toBe(true);   // benchmarking 198.18/15
    expect(isPrivateIPv4(ipv4ToInt('198.19.255.1')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('224.0.0.1')!)).toBe(true);    // multicast
    expect(isPrivateIPv4(ipv4ToInt('239.255.255.250')!)).toBe(true);
    expect(isPrivateIPv4(ipv4ToInt('240.0.0.1')!)).toBe(true);    // reserved
    expect(isPrivateIPv4(ipv4ToInt('255.255.255.255')!)).toBe(true);
  });
  it('allows public addresses', () => {
    expect(isPrivateIPv4(ipv4ToInt('1.1.1.1')!)).toBe(false);
    expect(isPrivateIPv4(ipv4ToInt('8.8.8.8')!)).toBe(false);
    expect(isPrivateIPv4(ipv4ToInt('223.255.255.254')!)).toBe(false); // last public before 224/4
  });
});

describe('isPrivateIPv6', () => {
  it('flags unspecified and loopback in every spelling', () => {
    expect(isPrivateIPv6('::')).toBe(true);
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('0:0:0:0:0:0:0:1')).toBe(true);
  });
  it('flags the WHOLE fe80::/10 link-local range, not just the fe80 prefix', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fe90::1')).toBe(true); // a `startsWith('fe80')` check misses these
    expect(isPrivateIPv6('feb0::1')).toBe(true);
    expect(isPrivateIPv6('febf::1')).toBe(true);
  });
  it('flags unique-local and multicast', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
    expect(isPrivateIPv6('ff02::1')).toBe(true);
  });
  it('unwraps v4-embedding forms and judges the embedded address', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIPv6('64:ff9b::10.0.0.1')).toBe(true);
    // A mapped PUBLIC address is genuinely reachable and not a bypass.
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
  });
  it('allows public unicast', () => {
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });
  it('fails closed on unparseable input', () => {
    expect(isPrivateIPv6('')).toBe(true);
    expect(isPrivateIPv6('not-an-address')).toBe(true);
  });
});

describe('normalizeRelay', () => {
  it('normalizes a bare host', () => {
    expect(normalizeRelay('nos.lol')).toBe('wss://nos.lol/');
    expect(normalizeRelay('  NOS.LOL  ')).toBe('wss://nos.lol/');
  });
  it('normalizes host:port — which URL() otherwise parses as a scheme', () => {
    // `new URL('nos.lol:443')` succeeds with scheme "nos.lol:", producing an
    // unusable relay entry. Regression guard for that exact input.
    expect(normalizeRelay('nos.lol:7777')).toBe('wss://nos.lol:7777/');
    // :443 is wss's default port, so canonicalization correctly drops it.
    expect(normalizeRelay('nos.lol:443')).toBe('wss://nos.lol/');
  });
  it('upgrades insecure/incorrect schemes to wss', () => {
    expect(normalizeRelay('ws://nos.lol')).toBe('wss://nos.lol/');
    expect(normalizeRelay('http://nos.lol')).toBe('wss://nos.lol/');
    expect(normalizeRelay('https://nos.lol')).toBe('wss://nos.lol/');
  });
  it('leaves an already-canonical wss URL alone', () => {
    expect(normalizeRelay('wss://relay.damus.io/')).toBe('wss://relay.damus.io/');
  });
  it('never emits a non-wss scheme for hostile input', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(isSecureRelay(normalizeRelay(bad))).toBe(false);
    }
  });
});

describe('isUnsafeHost — SSRF-encoding bypass coverage', () => {
  const unsafe = [
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '2130706433',        // decimal 127.0.0.1
    '0x7f000001',        // hex 127.0.0.1
    '0177.0.0.1',        // octal 127.0.0.1
    '127.1',             // short form
    '169.254.169.254',   // cloud metadata
    '[::1]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
  ];
  for (const h of unsafe) {
    it(`flags ${h}`, () => expect(isUnsafeHost(h)).toBe(true));
  }
  const safe = ['example.com', 'relay.damus.io', '1.1.1.1', '8.8.8.8'];
  for (const h of safe) {
    it(`allows ${h}`, () => expect(isUnsafeHost(h)).toBe(false));
  }
});

describe('shouldRejectUrl', () => {
  it('rejects SSRF-encoded image hosts', () => {
    expect(shouldRejectUrl('http://2130706433/x.png', 'media')).toBe(true);
    expect(shouldRejectUrl('http://0x7f000001/x.png', 'media')).toBe(true);
    expect(shouldRejectUrl('https://169.254.169.254/latest/meta-data', 'media')).toBe(true);
  });
  it('rejects credentials in URL', () => {
    expect(shouldRejectUrl('https://user:pass@example.com/a.png', 'media')).toBe(true);
  });
  it('allows normal https image URLs', () => {
    expect(shouldRejectUrl('https://image.nostr.build/abc.png', 'media')).toBe(false);
  });
});

describe('optimizeMediaUrl', () => {
  it('returns empty string for SSRF-encoded hosts', () => {
    expect(optimizeMediaUrl('http://2130706433/x.png')).toBe('');
  });
  it('passes through normal hosts', () => {
    expect(optimizeMediaUrl('https://example.com/a.png')).toContain('example.com');
  });
});

describe('isSecureRelay', () => {
  it('rejects SSRF-encoded relay hosts', () => {
    expect(isSecureRelay('wss://2130706433')).toBe(false);
    expect(isSecureRelay('wss://0x7f000001')).toBe(false);
    expect(isSecureRelay('wss://127.1')).toBe(false);
    expect(isSecureRelay('wss://[::1]')).toBe(false);
  });
  it('accepts normal wss relays', () => {
    expect(isSecureRelay('wss://relay.damus.io')).toBe(true);
    expect(isSecureRelay('wss://nos.lol')).toBe(true);
  });
  it('rejects non-wss', () => {
    expect(isSecureRelay('ws://relay.damus.io')).toBe(false);
    expect(isSecureRelay('https://relay.damus.io')).toBe(false);
  });
});
