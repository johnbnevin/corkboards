import { describe, it, expect } from 'vitest';
import { canonicalMediaUrl } from '@core/sanitizeUtils';

describe('canonicalMediaUrl', () => {
  const key = canonicalMediaUrl;

  it('treats http/https as equal', () => {
    expect(key('http://cdn.example.com/a.jpg')).toBe(key('https://cdn.example.com/a.jpg'));
  });

  it('ignores leading www. and host case', () => {
    expect(key('https://www.Example.com/a.jpg')).toBe(key('https://example.com/a.jpg'));
  });

  it('ignores a trailing slash and fragment', () => {
    expect(key('https://x.com/a/')).toBe(key('https://x.com/a'));
    expect(key('https://x.com/a#frag')).toBe(key('https://x.com/a'));
  });

  it('ignores trailing punctuation the content parser may grab', () => {
    expect(key('https://x.com/a.jpg).')).toBe(key('https://x.com/a.jpg'));
  });

  it('keeps query strings distinct (signed/expiring URLs)', () => {
    expect(key('https://x.com/a.jpg?sig=1')).not.toBe(key('https://x.com/a.jpg?sig=2'));
  });

  it('distinguishes genuinely different files', () => {
    expect(key('https://x.com/a.jpg')).not.toBe(key('https://x.com/b.jpg'));
  });

  it('is stable for unparseable input', () => {
    expect(key('not a url')).toBe(key('not a url'));
  });
});
