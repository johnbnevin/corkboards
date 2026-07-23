/**
 * Pure content detection utilities.
 * The actual sanitizeHtml function stays platform-specific (needs DOMPurify / DOM).
 */

/**
 * Checks if content contains actual HTML tags (not just angle brackets in text).
 * Requires a known HTML tag name to avoid false positives on things like
 * `<Bitcoin>`, `<insert name>`, `<3` in regular Nostr note text.
 */
const HTML_TAG_NAMES = 'a|b|i|u|p|br|hr|em|h[1-6]|ol|ul|li|dl|dt|dd|div|pre|img|nav|sub|sup|del|ins|var|kbd|wbr|map|col|span|code|font|link|meta|ruby|area|base|body|cite|data|form|head|html|main|mark|menu|slot|time|aside|embed|input|label|meter|param|small|style|table|tbody|tfoot|thead|title|track|video|audio|button|canvas|center|dialog|figure|footer|header|iframe|legend|object|option|output|script|select|source|strike|strong|summary|details|article|caption|section|picture|address|bdo|big|dfn|dir|rtc|svg|colgroup|datalist|fieldset|noscript|optgroup|progress|template|textarea|blockquote|figcaption'
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
