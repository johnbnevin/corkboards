import { htmlToPlainText } from '@core/sanitizeUtils';

// Re-export pure detection helpers from core
export { hasHtmlContent, isContentFromUser } from '@core/sanitizeUtils';

/**
 * Reduce HTML-looking user content to PLAIN TEXT — mobile mirror of
 * packages/web/src/lib/sanitize.ts.
 *
 * React Native has no DOM, so there is no DOMPurify here; the shared core
 * implementation does the same job without one (drops script/style bodies,
 * strips tags with quoted-attribute awareness, repeats until stable, decodes
 * entities LAST). Web runs DOMPurify first and then that same decode stage, so
 * both platforms produce the same string for the same input.
 *
 * ⚠ Returns PLAIN TEXT, not HTML. Render inside <Text> — never feed it to a
 * WebView's HTML or any innerHTML equivalent.
 *
 * The previous mobile-only implementation stripped tags with `/<[^>]*>/g` and
 * THEN decoded entities, so `&lt;img onerror=…&gt;` came back out as live
 * markup, and any tag carrying a `>` inside a quoted attribute was mis-parsed.
 */
export function sanitizeHtml(html: string): string {
  return htmlToPlainText(html);
}

/** Alias kept for existing mobile callers. Same plain-text contract. */
export const stripHtml = sanitizeHtml;
