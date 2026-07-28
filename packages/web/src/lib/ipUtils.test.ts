/**
 * Tests for the SSRF / private-range host checks in @core/ipUtils, and the
 * URL guards in @core/imageUtils and @core/nostrUtils that depend on them.
 */
import { describe, it, expect } from 'vitest';
import { ipv4ToInt, isPrivateIPv4, isPrivateIPv6, isUnsafeHost, expandIPv6 } from '@core/ipUtils';
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
    expect(ipv4ToInt('relay.nostr.net')).toBeNull();
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
    expect(normalizeRelay('wss://relay.nostr.net/')).toBe('wss://relay.nostr.net/');
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
  const safe = ['example.com', 'relay.nostr.net', '1.1.1.1', '8.8.8.8'];
  for (const h of safe) {
    it(`allows ${h}`, () => expect(isUnsafeHost(h)).toBe(false));
  }

  // The WHATWG URL parser strips a trailing root dot from IPv4 literals but
  // KEEPS it on domains, so `new URL('http://localhost./').hostname` is the
  // string `localhost.` — which resolves to loopback but matched none of the
  // checks above until the dot was normalized away.
  const trailingDot = ['localhost.', 'LOCALHOST.', 'foo.localhost.', 'localhost..'];
  for (const h of trailingDot) {
    it(`flags trailing-dot form ${h}`, () => expect(isUnsafeHost(h)).toBe(true));
  }
  it('still allows a public FQDN written with a trailing root dot', () => {
    expect(isUnsafeHost('example.com.')).toBe(false);
  });
  it('blocks the trailing-dot bypass end to end', () => {
    expect(isSecureRelay('wss://localhost.')).toBe(false);
    expect(shouldRejectUrl('http://localhost./x.png', 'media')).toBe(true);
    // …and confirm the hostname really does keep its dot, so this is not a
    // test that would pass vacuously if the parser changed.
    expect(new URL('http://localhost./').hostname).toBe('localhost.');
  });
});

describe('isUnsafeHost — IPv6 in the form URL.hostname actually produces', () => {
  // These MUST be driven through `new URL()`. The WHATWG parser re-serialises
  // every IPv6 literal into compressed hex hextets, so `[::ffff:127.0.0.1]`
  // reaches the gate as `[::ffff:7f00:1]` — with no dot in it. Asserting on the
  // hand-written dotted spelling (as this suite previously did) exercised a
  // branch that no real input can reach, and passed while every v4-mapped
  // loopback, RFC1918 and cloud-metadata address was being allowed through.
  const mapped: Array<[string, string]> = [
    ['http://[::ffff:127.0.0.1]/x.png', '[::ffff:7f00:1]'],
    ['http://[::ffff:169.254.169.254]/x.png', '[::ffff:a9fe:a9fe]'],
    ['http://[::ffff:10.0.0.1]/x.png', '[::ffff:a00:1]'],
    ['http://[::ffff:192.168.1.1]/x.png', '[::ffff:c0a8:101]'],
    ['http://[::127.0.0.1]/x.png', '[::7f00:1]'],
    ['http://[64:ff9b::127.0.0.1]/x.png', '[64:ff9b::7f00:1]'],
  ];
  for (const [url, expectedHost] of mapped) {
    it(`flags ${url}`, () => {
      const host = new URL(url).hostname;
      // Pin the canonical form so the test can't silently stop testing anything.
      expect(host).toBe(expectedHost);
      expect(isUnsafeHost(host)).toBe(true);
      expect(shouldRejectUrl(url, 'media')).toBe(true);
    });
  }

  it('flags v4-mapped relay hosts', () => {
    expect(isSecureRelay('wss://[::ffff:127.0.0.1]')).toBe(false);
    expect(isSecureRelay('wss://[::ffff:169.254.169.254]')).toBe(false);
    expect(isSecureRelay('wss://[64:ff9b::10.0.0.1]')).toBe(false);
  });

  it('flags 6to4 wrapping a private v4', () => {
    expect(isUnsafeHost('[2002:7f00:1::]')).toBe(true);   // 2002::/16 over 127.0.0.1
    expect(isUnsafeHost('[2002:a9fe:a9fe::]')).toBe(true); // over 169.254.169.254
  });

  it('flags link-local, unique-local, multicast and documentation ranges', () => {
    for (const h of ['[fe80::1]', '[febf::1]', '[fc00::1]', '[fd12:3456::1]', '[ff02::1]', '[2001:db8::1]', '[100::1]']) {
      expect(isUnsafeHost(h)).toBe(true);
    }
  });

  it('still allows genuine public IPv6', () => {
    for (const h of ['[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[2a00:1450:4001:80f::200e]']) {
      expect(isUnsafeHost(h)).toBe(false);
    }
    expect(isSecureRelay('wss://[2606:4700:4700::1111]')).toBe(true);
  });

  it('fails closed on malformed literals', () => {
    for (const h of ['[]', '[:::1]', '[gggg::1]', '[1:2:3:4:5:6:7:8:9]', '[1::2::3]', '[::1.2.3]', '[::1.2.3.999]']) {
      expect(isUnsafeHost(h)).toBe(true);
    }
  });
});

describe('expandIPv6', () => {
  it('expands compressed forms to 8 hextets', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIPv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });
  it('folds a trailing dotted quad into the last two hextets', () => {
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIPv6('64:ff9b::10.0.0.1')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x0a00, 1]);
  });
  it('returns null for malformed input', () => {
    for (const bad of ['', '1::2::3', 'gggg::', '1:2:3:4:5:6:7:8:9', '::1.2.3', '::1.2.3.999', '::0x7f.0.0.1']) {
      expect(expandIPv6(bad)).toBeNull();
    }
  });
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
    expect(isSecureRelay('wss://relay.nostr.net')).toBe(true);
    expect(isSecureRelay('wss://nos.lol')).toBe(true);
  });
  it('rejects non-wss', () => {
    expect(isSecureRelay('ws://relay.nostr.net')).toBe(false);
    expect(isSecureRelay('https://relay.nostr.net')).toBe(false);
  });
});
