/**
 * Shared utilities for truncating Nostr note content while preserving
 * non-visible spans (nostr refs, image markdown) and URLs.
 */

/**
 * Non-visible patterns that inflate character count (nostr refs, image markdown).
 *
 * Intentionally uses loose charset [a-zA-Z0-9] rather than strict Bech32 — we
 * want to skip anything that *looks* like a Nostr ref when counting visible
 * chars, even if it would fail nip19.decode(). This is a display heuristic,
 * not a protocol validator.
 */
const NON_VISIBLE_PATTERN = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+|!\[[^\]]*\]\([^)]*\)/g
const URL_PATTERN = /https?:\/\/[^\s]+/g

function nonVisibleRegex() { return new RegExp(NON_VISIBLE_PATTERN.source, NON_VISIBLE_PATTERN.flags) }
function urlRegex() { return new RegExp(URL_PATTERN.source, URL_PATTERN.flags) }

/** Count visible characters (excludes nostr references and image markdown, but keeps URLs) */
export function visibleLength(content: string): number {
  return content.replace(nonVisibleRegex(), '').replace(/\s+/g, ' ').trim().length
}

/**
 * Find the index in the original string where ~targetChars of visible text have been consumed.
 * Non-visible spans (nostr refs) are skipped in the count but included in the output position.
 * If the cutoff falls inside a URL, extends to include the full URL so it isn't broken.
 */
export function findVisibleCutoff(content: string, targetChars: number): number {
  if (targetChars <= 0) return 0
  let visible = 0
  let i = 0
  const nvRegex = nonVisibleRegex()
  let match = nvRegex.exec(content)

  while (i < content.length && visible < targetChars) {
    if (match && i === match.index) {
      i += match[0].length
      match = nvRegex.exec(content)
      continue
    }
    visible++
    i++
    while (match && match.index < i) {
      match = nvRegex.exec(content)
    }
  }

  // If cutoff landed inside a URL, extend to include the full URL
  const uRegex = urlRegex()
  let urlMatch
  while ((urlMatch = uRegex.exec(content)) !== null) {
    const urlEnd = urlMatch.index + urlMatch[0].length
    if (urlMatch.index < i && urlEnd > i) {
      i = urlEnd
      break
    }
  }

  return i
}
