import { describe, it, expect } from 'vitest';
import { stripTrackingParams } from '@core/sanitizeUtils';

describe('stripTrackingParams', () => {
  it('removes utm_* params', () => {
    expect(stripTrackingParams('https://example.com/a?utm_source=x&utm_medium=y'))
      .toBe('https://example.com/a');
  });

  it('removes known click trackers but keeps functional params', () => {
    expect(stripTrackingParams('https://shop.com/p?id=42&fbclid=abc&gclid=def'))
      .toBe('https://shop.com/p?id=42');
  });

  it('strips trackers mixed with real params, preserving order of the rest', () => {
    expect(stripTrackingParams('https://x.com/a?utm_campaign=z&q=hello&mc_eid=1'))
      .toBe('https://x.com/a?q=hello');
  });

  it('leaves clean URLs unchanged (same string)', () => {
    const clean = 'https://example.com/path?page=2';
    expect(stripTrackingParams(clean)).toBe(clean);
  });

  it('does not touch ambiguous short params (si, spm, scm)', () => {
    const url = 'https://youtu.be/abc?si=track123';
    expect(stripTrackingParams(url)).toBe(url);
  });

  it('returns non-http(s) and unparseable input unchanged', () => {
    expect(stripTrackingParams('mailto:a@b.com?utm_source=x')).toBe('mailto:a@b.com?utm_source=x');
    expect(stripTrackingParams('not a url')).toBe('not a url');
  });

  it('drops a dangling "?" when all params were trackers', () => {
    expect(stripTrackingParams('https://example.com/a?fbclid=xyz')).toBe('https://example.com/a');
  });
});
