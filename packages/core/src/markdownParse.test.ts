import { describe, it, expect } from 'vitest';
import { parseInlineSpans, parseMarkdownBlocks } from './markdownParse';

describe('parseInlineSpans', () => {
  it('returns a single plain span for plain text', () => {
    expect(parseInlineSpans('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('parses bold, italic, strike, and code', () => {
    expect(parseInlineSpans('a **b** c')).toEqual([
      { text: 'a ' }, { text: 'b', bold: true }, { text: ' c' },
    ]);
    expect(parseInlineSpans('a *b* c')).toEqual([
      { text: 'a ' }, { text: 'b', italic: true }, { text: ' c' },
    ]);
    expect(parseInlineSpans('a ~~b~~ c')).toEqual([
      { text: 'a ' }, { text: 'b', strike: true }, { text: ' c' },
    ]);
    expect(parseInlineSpans('a `b` c')).toEqual([
      { text: 'a ' }, { text: 'b', code: true }, { text: ' c' },
    ]);
  });

  it('nests emphasis (bold containing italic)', () => {
    expect(parseInlineSpans('**a *b* c**')).toEqual([
      { text: 'a ', bold: true },
      { text: 'b', bold: true, italic: true },
      { text: ' c', bold: true },
    ]);
  });

  it('does not treat code contents as further markdown', () => {
    expect(parseInlineSpans('`**not bold**`')).toEqual([{ text: '**not bold**', code: true }]);
  });

  it('parses links and attaches the url to the link text', () => {
    expect(parseInlineSpans('see [docs](https://example.com) here')).toEqual([
      { text: 'see ' },
      { text: 'docs', link: 'https://example.com' },
      { text: ' here' },
    ]);
  });

  it('leaves a lone unmatched marker as literal text', () => {
    expect(parseInlineSpans('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }]);
  });

  it('does not treat snake_case as italic', () => {
    expect(parseInlineSpans('some_variable_name')).toEqual([{ text: 'some_variable_name' }]);
  });
});

describe('parseMarkdownBlocks', () => {
  it('parses headings with levels', () => {
    const blocks = parseMarkdownBlocks('# Big\n## Small');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, spans: [{ text: 'Big' }] },
      { type: 'heading', level: 2, spans: [{ text: 'Small' }] },
    ]);
  });

  it('groups consecutive plain lines into one paragraph', () => {
    const blocks = parseMarkdownBlocks('line one\nline two');
    expect(blocks).toEqual([{ type: 'paragraph', spans: [{ text: 'line one\nline two' }] }]);
  });

  it('parses bullet and ordered lists with depth', () => {
    const blocks = parseMarkdownBlocks('- a\n  - b\n1. first');
    expect(blocks).toEqual([
      { type: 'bullet', depth: 0, spans: [{ text: 'a' }] },
      { type: 'bullet', depth: 1, spans: [{ text: 'b' }] },
      { type: 'ordered', depth: 0, marker: '1', spans: [{ text: 'first' }] },
    ]);
  });

  it('parses blockquotes, grouping consecutive lines', () => {
    const blocks = parseMarkdownBlocks('> a\n> b');
    expect(blocks).toEqual([{ type: 'quote', spans: [{ text: 'a\nb' }] }]);
  });

  it('parses fenced code blocks verbatim (no inline parsing)', () => {
    const blocks = parseMarkdownBlocks('```js\nconst x = **1**;\n```');
    expect(blocks).toEqual([{ type: 'code', value: 'const x = **1**;', lang: 'js' }]);
  });

  it('parses thematic breaks', () => {
    expect(parseMarkdownBlocks('---')).toEqual([{ type: 'hr' }]);
  });

  it('applies inline styling inside block spans', () => {
    const blocks = parseMarkdownBlocks('# a **b**');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, spans: [{ text: 'a ' }, { text: 'b', bold: true }] },
    ]);
  });
});
