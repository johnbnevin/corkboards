import DOMPurify from 'dompurify';
import { decodeHtmlEntities, htmlToPlainText } from '@core/sanitizeUtils';

// Re-export pure detection helpers from core
export { hasHtmlContent, isContentFromUser } from '@core/sanitizeUtils';

/**
 * Reduce HTML-looking user content to PLAIN TEXT.
 *
 * The app never renders other users' HTML as markup — HTML-looking note content
 * is flattened to text before display (see SmartNoteContent, ProfileAbout).
 *
 * Two stages, matching mobile's behaviour exactly (mobile calls the shared core
 * helper directly, having no DOM):
 *
 *   1. DOMPurify with an empty tag allowlist — a real parser, so adversarial
 *      nesting and malformed markup that defeat a regex are handled correctly,
 *      and `<script>`/`<style>` bodies are dropped rather than kept as text.
 *   2. Entity decoding — DOMPurify emits ESCAPED html (`&lt;b&gt;`), which React
 *      renders as the literal characters `&lt;b&gt;`. Decoding turns that back
 *      into the `<b>` the author actually typed. Safe here precisely because
 *      stage 1 already removed every tag, so nothing decodes into live markup.
 *
 * ⚠ Returns PLAIN TEXT, not HTML. Render as React children — never pass to
 * dangerouslySetInnerHTML.
 */
export function sanitizeHtml(html: string): string {
  const stripped = DOMPurify.sanitize(html, { ALLOWED_TAGS: [], KEEP_CONTENT: true });
  return decodeHtmlEntities(stripped);
}

/**
 * DOM-free fallback with identical semantics, for the rare paths that run
 * before/outside a DOM (SSR, tests, workers). Prefer `sanitizeHtml`.
 */
export { htmlToPlainText };
