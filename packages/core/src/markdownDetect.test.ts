import { describe, it, expect } from 'vitest';
import { contentHasAssumedMarkdown, MARKDOWN_INDICATORS_PATTERN } from './markdownDetect';

describe('contentHasAssumedMarkdown', () => {
  it('detects common markdown constructs', () => {
    expect(contentHasAssumedMarkdown('# Heading')).toBe(true);
    expect(contentHasAssumedMarkdown('- a list item')).toBe(true);
    expect(contentHasAssumedMarkdown('1. numbered')).toBe(true);
    expect(contentHasAssumedMarkdown('> a quote')).toBe(true);
    expect(contentHasAssumedMarkdown('some **bold** text')).toBe(true);
    expect(contentHasAssumedMarkdown('an `inline code` span')).toBe(true);
    expect(contentHasAssumedMarkdown('a [link](https://example.com)')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(contentHasAssumedMarkdown('just a normal sentence with no formatting')).toBe(false);
    expect(contentHasAssumedMarkdown('gm')).toBe(false);
  });

  it('bails out on very long content (ReDoS guard)', () => {
    expect(contentHasAssumedMarkdown('**x**'.repeat(3000))).toBe(false);
  });

  it('exposes a stateless (non-global) pattern reusable across calls', () => {
    expect(MARKDOWN_INDICATORS_PATTERN.global).toBe(false);
    expect(MARKDOWN_INDICATORS_PATTERN.test('## again')).toBe(true);
    expect(MARKDOWN_INDICATORS_PATTERN.test('## again')).toBe(true);
  });
});
