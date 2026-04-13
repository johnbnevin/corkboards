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
