// Re-export pure detection helpers from core
export { hasHtmlContent, isContentFromUser } from '@core/sanitizeUtils';

/**
 * Strips HTML tags from content using regex (no DOM needed on mobile).
 * For mobile, we don't render arbitrary HTML, so stripping is sufficient.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Sanitizes HTML content by stripping all tags.
 * Mobile equivalent of the web sanitizeHtml — since React Native doesn't
 * render HTML directly, we strip tags instead of allowlisting them.
 */
export function sanitizeHtml(html: string): string {
  return stripHtml(html);
}
