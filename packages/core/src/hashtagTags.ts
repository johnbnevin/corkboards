/**
 * Hashtag parsing — the one definition both the writers and the readers use.
 *
 * Three bugs this exists to prevent:
 *
 * 1. **URL fragments are not hashtags.** The composers append uploaded image
 *    URLs (and quoted `nostr:nevent1…` lines) to the note body before scanning
 *    it, so `https://host/pic.png#anchor` used to publish `['t','anchor']`.
 *    Relays index `t` tags, so the note surfaced in a hashtag feed it has
 *    nothing to do with. URLs are stripped before matching.
 *
 * 2. **Hashtags are not ASCII.** Reading them back used
 *    `/#(\p{L}[\p{L}\p{N}_]*)/gu` while writing them used `/#([a-zA-Z]\w*)/g`,
 *    so anything not spelled in English was silently never tagged.
 *
 * 3. **Two regexes drift.** The write side and the read side previously each
 *    carried their own copy with a "keep in sync" comment, which is how they
 *    got out of sync in the first place. There is now exactly one.
 *
 * A hashtag must contain at least one LETTER, but need not start with one.
 * Requiring a leading letter (the previous rule) threw away `#21million`,
 * `#100daysofcode` and `#2140` — ordinary tags, and the first is hard to miss in
 * a bitcoin-adjacent app. Allowing anything alphanumeric instead would sweep up
 * the "#2 of 5" and "#1" that appear in ordinary prose as numbering. The letter
 * requirement is what separates the two: a run of pure digits is a number, and
 * anything with a letter in it was typed as a word.
 */

/**
 * The canonical hashtag pattern.
 *
 * The lookahead is what enforces "at least one letter somewhere" — it scans the
 * candidate run before the capture commits to it.
 *
 * Carries the `g` flag, so use it only with `matchAll`/`replace` (which take an
 * internal copy). `test`/`exec` would leak `lastIndex` between callers.
 */
export const HASHTAG_RE = /#((?=[\p{L}\p{N}_]*\p{L})[\p{L}\p{N}_]+)/gu;

const URL_RE = /\b(?:https?|wss?):\/\/\S+/gi;
const NOSTR_URI_RE = /\bnostr:[a-z0-9]+/gi;

/** Replace URLs and `nostr:` URIs with spaces so their fragments can't match. */
export function stripLinks(content: string): string {
  return content.replace(URL_RE, ' ').replace(NOSTR_URI_RE, ' ');
}

/**
 * Lowercased, de-duplicated hashtags in `content`, ignoring anything inside a
 * URL or `nostr:` URI. NIP-01 `t` tag values are conventionally lowercase.
 */
export function extractHashtags(content: string): string[] {
  const seen = new Set<string>();
  for (const match of stripLinks(content).matchAll(HASHTAG_RE)) {
    seen.add(match[1].toLowerCase());
  }
  return [...seen];
}

/** `extractHashtags` as ready-to-publish `['t', value]` tags. */
export function buildHashtagTags(content: string): string[][] {
  return extractHashtags(content).map((tag) => ['t', tag]);
}
