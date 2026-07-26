import { describe, it, expect } from 'vitest';
import { hasHtmlContent } from './sanitizeUtils';

describe('hasHtmlContent', () => {
  it('detects table cells and short inline tags that were previously missed', () => {
    for (const html of ['<td>x</td>', '<tr><td>x</td></tr>', '<th>h</th>', '<s>x</s>', '<q>x</q>', '<abbr>x</abbr>', '<samp>x</samp>']) {
      expect(hasHtmlContent(html)).toBe(true);
    }
  });

  it('still detects common tags', () => {
    expect(hasHtmlContent('<div>x</div>')).toBe(true);
    expect(hasHtmlContent('<img src="x">')).toBe(true);
    expect(hasHtmlContent('<strong>x</strong>')).toBe(true);
  });

  it('does not false-positive on plain text with angle brackets', () => {
    expect(hasHtmlContent('i <3 nostr')).toBe(false);
    expect(hasHtmlContent('cost < 5 and > 2')).toBe(false);
    expect(hasHtmlContent('<insert name here>')).toBe(false);
    // 's' is a tag but the anchor requires it to END the tag name, so a longer
    // word starting with s doesn't trip it.
    expect(hasHtmlContent('<solid>')).toBe(false);
  });
});
