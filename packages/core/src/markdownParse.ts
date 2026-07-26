/**
 * Minimal, dependency-free markdown parser shared by the platforms that can't
 * use a DOM markdown library (mobile/desktop RN). Web keeps using react-markdown
 * (full GFM); this covers the constructs that actually show up in Nostr notes:
 * headings, blockquotes, bullet/ordered lists, fenced code, thematic breaks, and
 * inline bold/italic/strikethrough/code/links.
 *
 * Two pure functions:
 *   parseMarkdownBlocks(text) → block list (headings, lists, code, …)
 *   parseInlineSpans(text)    → styled inline spans for one block of text
 *
 * Both are string-in / data-out so a renderer (RN <Text>/<View>) can map the
 * result to platform components. Kept deliberately small and heavily unit-tested
 * because it renders attacker-controlled note content on clients we can't easily
 * eyeball.
 */

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** When set, this span is a link to the given (http/https) URL. */
  link?: string;
}

export type MarkdownBlock =
  | { type: 'heading'; level: number; spans: InlineSpan[] }
  | { type: 'paragraph'; spans: InlineSpan[] }
  | { type: 'bullet'; depth: number; spans: InlineSpan[] }
  | { type: 'ordered'; depth: number; marker: string; spans: InlineSpan[] }
  | { type: 'quote'; spans: InlineSpan[] }
  | { type: 'code'; value: string; lang?: string }
  | { type: 'hr' };

interface SpanStyle { bold?: boolean; italic?: boolean; strike?: boolean }

// Inline markers, checked earliest-position-first with ties broken by array order
// (code and links win over emphasis so their delimiters aren't eaten by * / _).
// Each pattern has one capture group for the inner text; links have a second for
// the URL. All are /g so we can seek from an offset via lastIndex.
const INLINE_MARKERS: { kind: 'code' | 'link' | 'bold' | 'strike' | 'italic'; re: RegExp }[] = [
  { kind: 'code', re: /`([^`\n]+)`/g },
  { kind: 'link', re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g },
  { kind: 'bold', re: /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g },
  { kind: 'strike', re: /~~([\s\S]+?)~~/g },
  { kind: 'italic', re: /\*(?!\s)([^*\n]+?)\*|(?<![A-Za-z0-9])_(?!\s)([^_\n]+?)_(?![A-Za-z0-9])/g },
];

interface Marker {
  kind: 'code' | 'link' | 'bold' | 'strike' | 'italic';
  index: number;
  end: number;
  inner: string;
  url?: string;
}

/** Find the earliest inline marker at or after `from`, or null if none. */
function findNextMarker(text: string, from: number): Marker | null {
  let best: Marker | null = null;
  for (const { kind, re } of INLINE_MARKERS) {
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) continue;
    const inner = kind === 'link'
      ? m[1]
      : (m[1] ?? m[2] ?? '');
    const candidate: Marker = {
      kind,
      index: m.index,
      end: m.index + m[0].length,
      inner,
      url: kind === 'link' ? m[2] : undefined,
    };
    // Earliest position wins; on a tie the earlier marker in INLINE_MARKERS wins.
    if (!best || candidate.index < best.index) best = candidate;
  }
  return best;
}

function styleFlags(s: SpanStyle): SpanStyle {
  const out: SpanStyle = {};
  if (s.bold) out.bold = true;
  if (s.italic) out.italic = true;
  if (s.strike) out.strike = true;
  return out;
}

function pushText(out: InlineSpan[], text: string, style: SpanStyle): void {
  if (!text) return;
  out.push({ text, ...styleFlags(style) });
}

function parseInlineInto(text: string, style: SpanStyle, out: InlineSpan[]): void {
  let i = 0;
  while (i < text.length) {
    const marker = findNextMarker(text, i);
    if (!marker) { pushText(out, text.slice(i), style); return; }
    if (marker.index > i) pushText(out, text.slice(i, marker.index), style);

    if (marker.kind === 'code') {
      out.push({ text: marker.inner, code: true, ...styleFlags(style) });
    } else if (marker.kind === 'link') {
      // Link text may itself contain emphasis; parse it, then attach the URL.
      const inner: InlineSpan[] = [];
      parseInlineInto(marker.inner, style, inner);
      if (inner.length === 0) out.push({ text: marker.inner, link: marker.url, ...styleFlags(style) });
      else for (const s of inner) out.push({ ...s, link: marker.url });
    } else {
      const next: SpanStyle = { ...style };
      next[marker.kind] = true;
      parseInlineInto(marker.inner, next, out);
    }
    i = marker.end;
  }
}

/** Merge neighbouring spans with identical styling to cut node count. */
function coalesce(spans: InlineSpan[]): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && !prev.code && !s.code && !!prev.bold === !!s.bold && !!prev.italic === !!s.italic
      && !!prev.strike === !!s.strike && prev.link === s.link) {
      prev.text += s.text;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Parse one line/segment of text into styled inline spans. */
export function parseInlineSpans(text: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  parseInlineInto(text, {}, out);
  return coalesce(out);
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const FENCE_RE = /^\s{0,3}```(.*)$/;

/** Indent → nesting depth (2 spaces per level, capped so deep indents don't run away). */
function indentDepth(indent: string): number {
  return Math.min(6, Math.floor(indent.replace(/\t/g, '  ').length / 2));
}

/**
 * Parse a block of text (one "markdown text" segment) into block-level nodes.
 * Consecutive plain lines coalesce into a paragraph (newlines preserved as soft
 * breaks, matching remark-breaks on web).
 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join('\n').replace(/\n+$/, '');
    if (joined.trim()) blocks.push({ type: 'paragraph', spans: parseInlineSpans(joined) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block — consume until the closing fence (or EOF).
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1].trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) { body.push(lines[i]); i++; }
      blocks.push({ type: 'code', value: body.join('\n'), lang });
      continue; // i sits on the closing fence (or past EOF); loop's i++ steps over it
    }

    if (line.trim() === '') { flushParagraph(); continue; }

    if (HR_RE.test(line)) { flushParagraph(); blocks.push({ type: 'hr' }); continue; }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInlineSpans(heading[2]) });
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushParagraph();
      // Group consecutive quote lines into one blockquote.
      const quoted: string[] = [quote[1]];
      while (i + 1 < lines.length && QUOTE_RE.test(lines[i + 1])) {
        quoted.push(QUOTE_RE.exec(lines[i + 1])![1]);
        i++;
      }
      blocks.push({ type: 'quote', spans: parseInlineSpans(quoted.join('\n')) });
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flushParagraph();
      blocks.push({ type: 'ordered', depth: indentDepth(ordered[1]), marker: ordered[2], spans: parseInlineSpans(ordered[3]) });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: 'bullet', depth: indentDepth(bullet[1]), spans: parseInlineSpans(bullet[2]) });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
