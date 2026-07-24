/**
 * Shared markdown-detection heuristic for note content.
 *
 * Kind-1 notes are plain text by protocol, but the app renders markdown-style
 * formatting (bold, lists, headings, …) heuristically. This pattern is the
 * single source of truth for "does this text look like markdown", used both to
 * retag text parts for rendering (NoteContent) and to decide whether to offer a
 * per-note "show original" toggle (SmartNoteContent).
 */

// Instantiated once; has no /g flag, so `.test()` is stateless and reusable.
export const MARKDOWN_INDICATORS_PATTERN = /(?:^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>|`|^\s*---\s*$|^\s*\*\*\*\s*$|\*\*|__|\*[^*\s].*\*|_[^_\s].*_|~~.+~~|\|.+\||\[[^\]]+\]\(https?:|!\[|^\s*- \[[ x]\])/m

/**
 * Cheap heuristic for whether a note's text would be rendered as assumed
 * markdown (used to decide whether to offer a per-note "show original" toggle).
 * Guards against ReDoS on very long segments.
 */
export function contentHasAssumedMarkdown(content: string): boolean {
  return content.length <= 10_000 && MARKDOWN_INDICATORS_PATTERN.test(content)
}
