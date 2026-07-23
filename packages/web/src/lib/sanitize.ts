import DOMPurify from 'dompurify';

// Re-export pure detection helpers from core
export { hasHtmlContent, isContentFromUser } from '@core/sanitizeUtils';

/**
 * Strips ALL HTML tags from user-generated content, keeping only the text.
 *
 * The app never renders other users' HTML as markup — HTML-looking note
 * content is reduced to plain text before display (see SmartNoteContent).
 * DOMPurify with an empty tag allowlist handles malformed/adversarial HTML
 * reliably where a regex would not.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: [], KEEP_CONTENT: true });
}
