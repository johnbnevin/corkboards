/**
 * Pure content detection utilities.
 * The actual sanitizeHtml function stays platform-specific (needs DOMPurify / DOM).
 */

/**
 * Checks if content contains actual HTML tags (not just angle brackets in text).
 * Requires a known HTML tag name to avoid false positives on things like
 * `<Bitcoin>`, `<insert name>`, `<3` in regular Nostr note text.
 */
// NOTE: keep table cells (tr/td/th) and the short inline tags (s/q) in this list
// — content using ONLY those (e.g. `<td>x</td>`, `<s>x</s>`) is still HTML the
// "hide HTML" filter must detect, even though htmlToPlainText strips any tag.
const HTML_TAG_NAMES = 'a|b|i|u|p|q|s|br|hr|em|h[1-6]|ol|ul|li|dl|dt|dd|tr|td|th|rp|rt|div|pre|img|nav|sub|sup|del|ins|var|kbd|wbr|map|col|bdi|abbr|samp|hgroup|span|code|font|link|meta|ruby|area|base|body|cite|data|form|head|html|main|mark|menu|slot|time|aside|embed|input|label|meter|param|small|style|table|tbody|tfoot|thead|title|track|video|audio|button|canvas|center|dialog|figure|footer|header|iframe|legend|object|option|output|script|select|source|strike|strong|summary|details|article|caption|section|picture|address|bdo|big|dfn|dir|rtc|svg|colgroup|datalist|fieldset|noscript|optgroup|progress|template|textarea|blockquote|figcaption'
const HTML_DETECT_RE = new RegExp(`<(${HTML_TAG_NAMES})(\\s|>|/>)`, 'i')

export function hasHtmlContent(content: string): boolean {
  return HTML_DETECT_RE.test(content);
}

/**
 * Checks if content is from the logged-in user
 */
export function isContentFromUser(contentPubkey: string, userPubkey?: string): boolean {
  return !!userPubkey && contentPubkey === userPubkey;
}

// ─── HTML → plain text ───────────────────────────────────────────────────────
//
// The app never renders another user's HTML as markup. HTML-looking note bodies
// and profile fields are reduced to plain text before display. This is the
// shared, DOM-free implementation used directly by React Native and as the
// entity-decoding stage of the web path (see packages/web/src/lib/sanitize.ts,
// which runs DOMPurify first because a real parser beats a regex on adversarial
// nesting).
//
// ⚠ The return value is PLAIN TEXT, not HTML. Entities are decoded, so the
// output may contain bare `<`, `>` and `&`. Render it as text (React children,
// RN <Text>) — never assign it to innerHTML/dangerouslySetInnerHTML. The naive
// version of this ("strip tags, then decode entities") is exactly how
// `&lt;img onerror=…&gt;` turns back into live markup one layer up.

/** Elements whose *content* is markup-adjacent and must be dropped, not kept. */
const VOID_CONTENT_ELEMENTS = 'script|style|template|noscript|iframe|object|embed|svg|math';
const VOID_CONTENT_RE = new RegExp(`<(${VOID_CONTENT_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
/** Same, unterminated: `<script>…` with no closing tag runs to end of input. */
const VOID_CONTENT_OPEN_RE = new RegExp(`<(${VOID_CONTENT_ELEMENTS})\\b[\\s\\S]*$`, 'i');

/**
 * Match a single HTML tag, honouring quoted attribute values so a `>` inside an
 * attribute doesn't terminate the match early. `<a title="a>b">` is one tag —
 * the naive `/<[^>]*>/` splits it and leaks `b">` into the output as text.
 */
const HTML_TAG_RE = /<\/?[a-zA-Z][^\s/>]*(?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?>|<!--[\s\S]*?-->|<![^>]*>/g;

/** Max tag-stripping passes. Bounded so malformed input can't spin forever. */
const MAX_STRIP_PASSES = 8;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', copy: '©',
  reg: '®', trade: '™', deg: '°', middot: '·',
  bull: '•', laquo: '«', raquo: '»', times: '×',
  divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢',
};

/**
 * Decode HTML character references. `&amp;` is decoded LAST via a placeholder so
 * a double-encoded `&amp;lt;` yields the literal text `&lt;` rather than `<` —
 * decoding `&amp;` first would let one extra encoding layer smuggle a tag
 * through anything that re-parses this string.
 */
export function decodeHtmlEntities(input: string): string {
  // ONE left-to-right pass over all three reference forms. Scanning continues
  // after each replacement, never over it, which is what makes double-encoding
  // safe for free: `&amp;lt;` matches `&amp;` first, the scanner resumes at
  // `lt;`, and the result is the literal text `&lt;` rather than `<`. Decoding
  // `&amp;` in a separate earlier pass would have turned that into a real tag
  // for anything downstream that re-parses the string.
  return input.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi,
    (raw, body: string) => {
      if (body[0] === '#') {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        return codePointOrRaw(code, raw);
      }
      const v = NAMED_ENTITIES[body.toLowerCase()];
      return v === undefined ? raw : v;
    },
  );
}

/** Code point → character, or the original text when out of range / a surrogate. */
function codePointOrRaw(code: number, raw: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return raw;
  if (code >= 0xd800 && code <= 0xdfff) return raw; // lone surrogate
  try {
    return String.fromCodePoint(code);
  } catch {
    return raw;
  }
}

/**
 * Reduce HTML-ish content to plain text: drop script/style/embed blocks with
 * their contents, strip every remaining tag, then decode character references.
 * Repeats the strip pass until the string stops changing so `<<b>b>` and other
 * malformed nestings can't leave a live tag behind.
 *
 * @returns plain text — see the ⚠ note above; never insert as HTML.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  let out = html.replace(VOID_CONTENT_RE, ' ').replace(VOID_CONTENT_OPEN_RE, ' ');
  for (let i = 0; i < MAX_STRIP_PASSES; i++) {
    const next = out.replace(HTML_TAG_RE, '');
    if (next === out) break;
    out = next;
  }
  // Decode only after every tag is gone: an entity that decodes into `<…>` is
  // then plain text, not markup we would have to strip again.
  return decodeHtmlEntities(out);
}

// ─── External-link scheme gate ───────────────────────────────────────────────

/**
 * True when a URL is safe to hand to an external opener — `window.open`,
 * `<a href>`, or React Native's `Linking.openURL`.
 *
 * Only http(s) passes. Everything else is refused, which on mobile is the point
 * that matters most: `Linking.openURL` will launch ANY scheme the OS has a
 * handler for. A note author controls this string, so without a gate a note can
 * fire `intent://` (Android activity launch), `market://`, `tel:`/`sms:`,
 * `file:`, or a private scheme belonging to another installed app — from a tap
 * on what looks like an ordinary link. On web the same check blocks
 * `javascript:` and `data:` URLs.
 *
 * This lived as three separate copies (web WebLink, mobile WebLink, mobile
 * MediaLink) and was simply absent at most mobile open sites. One definition,
 * used everywhere, is what keeps the platforms from drifting again.
 */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  // Reject embedded control characters outright: they can split a scheme across
  // a line in lenient parsers ("java\nscript:") and never appear in a
  // legitimate URL.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

// ─── Link tracker stripping ──────────────────────────────────────────────────
//
// Removes well-known analytics/click-tracking query parameters from URLs before
// they're rendered, so users don't leak referral fingerprints and links look
// clean. Only KNOWN tracking params are removed — functional params (auth
// tokens, signatures, ids the site needs) are preserved, so this is safe to run
// on any external link. Ambiguous short params (si, spm, scm) are intentionally
// excluded to avoid breaking legitimate links.

const TRACKING_PARAM_PREFIXES = [
  'utm_', 'fb_', 'ga_', '_hs', 'hsa_', 'mc_', 'oly_', 'vero_', 'pk_', 'mtm_', 'matomo_', 'piwik_',
];

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source',
  'msclkid', 'twclid', 'ttclid', 'igshid', 'igsh', 'yclid', 'ysclid', '_openstat',
  '__hssc', '__hstc', '__hsfp', 'hsctatracking',
  'mkt_tok', 's_cid', 'ml_subscriber', 'ml_subscriber_hash',
  'ref_src', 'ref_url', '_ga', '_gl',
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_PARAMS.has(k) || TRACKING_PARAM_PREFIXES.some(p => k.startsWith(p));
}

/**
 * List the known tracking parameter names present in an http(s) URL.
 * Returns [] when the URL can't be parsed, isn't http(s), or is clean.
 * Used by the tracker-warning UI to show the user exactly what was detected.
 */
export function getTrackingParams(rawUrl: string): string[] {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
    return [...new Set([...u.searchParams.keys()].filter(isTrackingParam))];
  } catch {
    return [];
  }
}

/**
 * Strip known tracking parameters from an http(s) URL. Returns the original
 * string unchanged if it can't be parsed, isn't http(s), or has no trackers.
 */
export function stripTrackingParams(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
    const toDelete = [...u.searchParams.keys()].filter(isTrackingParam);
    if (toDelete.length === 0) return rawUrl;
    for (const key of toDelete) u.searchParams.delete(key);
    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    return rawUrl;
  }
}

// ─── Media URL canonicalization (for dedup only) ─────────────────────────────
//
// Produces a comparison KEY for media URLs so the same file referenced two ways
// (e.g. once in the note content and once in an imeta/NIP-92 tag) dedupes to a
// single render. This is used ONLY for equality checks — never for display; we
// always render the URL exactly as authored.
//
// Normalizes the differences that legitimately vary between a content URL and
// its imeta twin: scheme (http/https), leading "www.", host case, a trailing
// slash, the URL fragment, and trailing punctuation the content parser may have
// grabbed. Query strings are preserved, since for media they can be significant
// (signed/expiring URLs, Blossom hashes) and stripping them could over-merge
// genuinely distinct files.
export function canonicalMediaUrl(rawUrl: string): string {
  const s = rawUrl.trim().replace(/[),.;:!]+$/, '');
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    // Scheme-agnostic key: host + path + query (no fragment).
    return `${host}${path}${u.search}`;
  } catch {
    return s.toLowerCase();
  }
}
