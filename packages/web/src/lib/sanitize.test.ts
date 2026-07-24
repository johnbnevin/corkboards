/**
 * Tests for the shared HTML→plain-text reduction in @core/sanitizeUtils and the
 * web wrapper in @/lib/sanitize.
 *
 * Both platforms must agree: mobile calls `htmlToPlainText` directly (no DOM),
 * web runs DOMPurify first and then the same entity-decoding stage. A divergence
 * between them is the bug this file exists to catch — mobile previously stripped
 * tags with `/<[^>]*>/g` and THEN decoded entities, which turned an encoded tag
 * back into live markup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { htmlToPlainText, decodeHtmlEntities, hasHtmlContent } from '@core/sanitizeUtils';
import { sanitizeHtml } from '@/lib/sanitize';

/** Run an input through both platform paths and assert they agree. */
function bothPlatforms(input: string): { web: string; mobile: string } {
  return { web: sanitizeHtml(input), mobile: htmlToPlainText(input) };
}

describe('htmlToPlainText', () => {
  it('strips simple tags but keeps their text', () => {
    expect(htmlToPlainText('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('drops script bodies rather than exposing them as text', () => {
    expect(htmlToPlainText('a<script>alert(1)</script>b')).not.toContain('alert(1)');
  });

  it('drops an unterminated script body', () => {
    expect(htmlToPlainText('safe<script>alert(1)')).not.toContain('alert(1)');
  });

  it('drops style and svg bodies', () => {
    expect(htmlToPlainText('x<style>body{}</style>y')).not.toContain('body{}');
    expect(htmlToPlainText('x<svg><g onload="e()"/></svg>y')).not.toContain('onload');
  });

  it('handles a `>` inside a quoted attribute as part of the tag', () => {
    // The naive /<[^>]*>/ stops at the attribute's `>` and leaks `b">` as text.
    expect(htmlToPlainText('<a title="a>b">link</a>')).toBe('link');
    expect(htmlToPlainText("<a title='a>b'>link</a>")).toBe('link');
  });

  it('keeps stripping until stable so malformed nesting leaves no tag', () => {
    expect(htmlToPlainText('<<b>b>text')).not.toContain('<b>');
    expect(htmlToPlainText('<scr<script>ipt>x</script>')).not.toMatch(/<\s*script/i);
  });

  it('strips comments and doctypes', () => {
    expect(htmlToPlainText('a<!-- hidden -->b')).toBe('ab');
    expect(htmlToPlainText('<!DOCTYPE html>text')).toBe('text');
  });

  it('leaves plain text — including lone angle brackets — untouched', () => {
    expect(htmlToPlainText('2 < 3 and 5 > 4')).toBe('2 < 3 and 5 > 4');
    expect(htmlToPlainText('I <3 nostr')).toBe('I <3 nostr');
  });

  it('returns empty for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeHtmlEntities('&lt;b&gt;')).toBe('<b>');
    expect(decodeHtmlEntities('&#60;b&#62;')).toBe('<b>');
    expect(decodeHtmlEntities('&#x3c;b&#x3e;')).toBe('<b>');
    expect(decodeHtmlEntities('caf&#233;')).toBe('café');
  });

  it('leaves unknown entities alone rather than mangling them', () => {
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
  });

  it('decodes &amp; last, so one extra encoding layer survives as text', () => {
    // `&amp;lt;` means the literal text "&lt;" — decoding &amp; first would
    // produce "&lt;" and then "<", smuggling a tag through a second parse.
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
  });

  it('rejects out-of-range and surrogate code points', () => {
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeHtmlEntities('&#0;')).toBe('&#0;');
  });
});

describe('web and mobile sanitizers agree', () => {
  const cases = [
    '<b>bold</b>',
    '<a title="a>b">link</a>',
    'plain text with no markup',
    '2 < 3',
    '&lt;b&gt;encoded&lt;/b&gt;',
    '&amp;lt;double encoded&amp;gt;',
    'caf&#233; &hellip; done',
    '<p>one</p><p>two</p>',
  ];
  for (const input of cases) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      const { web, mobile } = bothPlatforms(input);
      expect(web).toBe(mobile);
    });
  }
});

describe('sanitizeHtml (web) — output is plain text, not escaped HTML', () => {
  it('decodes entities so the reader sees what the author typed', () => {
    // DOMPurify alone returns `&lt;b&gt;`, which React renders as the literal
    // characters "&lt;b&gt;" — the decode stage is what makes this readable.
    expect(sanitizeHtml('&lt;b&gt;')).toBe('<b>');
  });

  it('removes markup that hasHtmlContent flags', () => {
    const evil = '<img src=x onerror="alert(1)">caption';
    expect(hasHtmlContent(evil)).toBe(true);
    const out = sanitizeHtml(evil);
    expect(out).not.toContain('onerror');
    expect(out).toContain('caption');
  });

  it('renders an encoded tag as the literal text the author typed', () => {
    // `&lt;img …&gt;` IS the text "<img …>" — that is what any HTML renderer
    // shows, and both platforms must agree on it. This is only safe because the
    // result is contracted as PLAIN TEXT and every consumer renders it as text:
    // React/RN escape their children, and NoteContent's <ReactMarkdown> runs
    // WITHOUT rehype-raw (not installed), so react-markdown escapes raw HTML in
    // the markdown source instead of parsing it. See the sibling test below,
    // which pins that invariant.
    const out = sanitizeHtml('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toBe('<img src=x onerror=alert(1)>');
    expect(out).toBe(htmlToPlainText('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('one extra encoding layer stays inert', () => {
    // `&amp;lt;` must NOT collapse all the way to `<`, or a second parse
    // somewhere downstream would see a tag the author never wrote.
    expect(sanitizeHtml('&amp;lt;img src=x&amp;gt;')).toBe('&lt;img src=x&gt;');
  });
});

describe('markdown rendering does not re-parse sanitized text as HTML', () => {
  // The plain-text contract of sanitizeHtml rests on this invariant: react-markdown
  // escapes raw HTML in its source UNLESS a raw-HTML rehype plugin is added. If one
  // ever is, decoded text like `<img src=x onerror=…>` becomes a live element and
  // this whole pipeline turns into an XSS. Assert it structurally so the guard can't
  // be removed silently.
  const noteContent = readFileSync(
    resolve(__dirname, '../components/NoteContent.tsx'),
    'utf8',
  );

  it('does not pass any rehype plugin to <ReactMarkdown>', () => {
    expect(noteContent).toContain('<ReactMarkdown');
    expect(noteContent).not.toMatch(/rehypePlugins/);
  });

  it('does not depend on a raw-HTML rehype plugin', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all)).not.toContain('rehype-raw');
  });
});
