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
const NON_VISIBLE_PATTERN = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+|!\[[^\]]*\]\([^)]*\)/
const URL_PATTERN = /https?:\/\/[^\s]+/

function nonVisibleRegex() { return new RegExp(NON_VISIBLE_PATTERN.source, 'g') }
function urlRegex() { return new RegExp(URL_PATTERN.source, 'g') }

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
  // Mirror visibleLength's whitespace model: runs of whitespace collapse to a
  // single counted char and leading whitespace doesn't count. Start as if
  // preceded by space so a leading run is skipped (matches the .trim()).
  let prevWasSpace = true
  const nvRegex = nonVisibleRegex()
  let match = nvRegex.exec(content)

  while (i < content.length && visible < targetChars) {
    if (match && i === match.index) {
      i += match[0].length
      match = nvRegex.exec(content)
      prevWasSpace = false // a non-visible span ends any whitespace run
      continue
    }
    const isSpace = /\s/.test(content[i])
    if (isSpace && prevWasSpace) {
      // collapsed whitespace — consume position without counting it
      i++
    } else {
      visible++
      i++
      prevWasSpace = isSpace
    }
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

/**
 * Truncate for a preview, ending with an ellipsis that cannot corrupt the last
 * token.
 *
 * The ellipsis must be separated from the text. Callers used to do
 * `slice(...).trimEnd() + '…'`, and because `findVisibleCutoff` deliberately
 * extends the cut to the END of a URL, the result was routinely
 * `https://host/abc.jpg…` — one token, no whitespace. Every downstream check is
 * anchored to the end of the URL (`/\.(jpg|png|…)$/` on the pathname), so the
 * glued ellipsis made a perfectly good image URL stop being recognized as
 * media: it rendered as a raw link, and — because the content no longer
 * contained a media URL to dedup against — the note's NIP-92 `imeta` copy of
 * the very same image was then appended as "not already shown inline". One
 * image, two renderings of it, in every truncated/nested preview.
 *
 * A space before the ellipsis is enough: the URL token ends at whitespace
 * exactly as it does in untruncated content.
 */
export function truncateForPreview(content: string, targetChars: number): string {
  const cut = findVisibleCutoff(content, targetChars)
  if (cut >= content.length) return content
  return content.slice(0, cut).trimEnd() + ' …'
}
