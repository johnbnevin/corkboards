import DOMPurify from 'dompurify';

// Re-export pure detection helpers from core
export { hasHtmlContent, isContentFromUser } from '@core/sanitizeUtils';

/**
 * Sanitizes HTML content to prevent XSS attacks while preserving safe content.
 * This is used for rendering content from other users (friends, etc.)
 *
 * Security philosophy: Defense in depth - even if we trust the source,
 * we sanitize everything to prevent injection attacks.
 */
export function sanitizeHtml(html: string): string {
  // Configure DOMPurify with paranoid settings
  const config = {
    ALLOWED_TAGS: [
      'b', 'i', 'u', 'em', 'strong', 'span', 'div',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'blockquote',
      'a', 'img', 'video', 'audio',
      'pre', 'code', 'ul', 'ol', 'li',
      'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'small', 'sub', 'sup', 'mark'
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'width', 'height',
      'controls', 'preload', 'loading', 'class'
    ],
    // Paranoid settings - disable everything potentially dangerous
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOW_ARIA_ATTR: false,
    USE_PROFILES: { html: true },
    // Explicitly forbid dangerous elements
    FORBID_TAGS: [
      'script', 'style', 'iframe', 'object', 'embed',
      'form', 'input', 'button', 'textarea', 'select',
      'meta', 'link', 'base', 'noscript', 'template',
      'svg', 'math' // Can contain script-like behavior
    ],
    // Forbid all event handlers and dangerous attributes
    FORBID_ATTR: [
      'onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout',
      'onfocus', 'onblur', 'onsubmit', 'onreset', 'onchange',
      'onkeydown', 'onkeyup', 'onkeypress', 'ondblclick',
      'onmousedown', 'onmouseup', 'onmousemove', 'onmouseenter', 'onmouseleave',
      'ontouchstart', 'ontouchmove', 'ontouchend',
      'onscroll', 'onresize', 'onwheel',
      'style', 'target', 'rel', // Remove style to prevent CSS injection
      'formaction', 'xlink:href', 'xmlns'
    ],
  };

  // Sanitize the HTML
  const sanitized = DOMPurify.sanitize(html, config);

  return sanitized;
}
