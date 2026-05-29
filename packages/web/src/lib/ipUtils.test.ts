/**
 * Tests for the SSRF / private-range host checks in @core/ipUtils, and the
 * URL guards in @core/imageUtils and @core/nostrUtils that depend on them.
 */
import { describe, it, expect } from 'vitest';
import { ipv4ToInt, isPrivateIPv4, isUnsafeHost } from '@core/ipUtils';
import { shouldRejectUrl, optimizeMediaUrl } from '@core/imageUtils';
import { isSecureRelay } from '@core/nostrUtils';

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
  it('allows public addresses', () => {
    expect(isPrivateIPv4(ipv4ToInt('1.1.1.1')!)).toBe(false);
    expect(isPrivateIPv4(ipv4ToInt('8.8.8.8')!)).toBe(false);
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
