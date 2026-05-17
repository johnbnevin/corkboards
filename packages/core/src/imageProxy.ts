/**
 * Image proxy — rewrites image URLs through a user-configured template
 * (e.g. `https://wsrv.nl/?url={url}`) so the user's IP and Referer aren't
 * exposed to every random image host linked from Nostr content.
 *
 * Two-piece design:
 *   - This pure helper does the rewrite given a template.
 *   - Each platform (web, mobile) reads its persisted setting and calls
 *     `setImageProxyTemplate(...)` once on startup; the active template is
 *     then applied by `optimizeMediaUrl` / `optimizeAvatarUrl`.
 *
 * Opt-in: when the template is empty/null, URLs pass through unchanged so
 * we don't concentrate traffic on any single third-party host by default.
 *
 * Safety: only http(s) URLs are rewritten; data:, blob:, and anything else
 * is returned as-is so we don't break QR codes or generated avatars.
 */

let _imageProxyTemplate: string | null = null;

/**
 * Set the active proxy template. Use `null` or empty string to disable.
 * The template must contain `{url}` — at rewrite time we substitute
 * `encodeURIComponent(originalUrl)` for that placeholder.
 */
export function setImageProxyTemplate(template: string | null | undefined): void {
  const trimmed = template?.trim();
  _imageProxyTemplate = trimmed && trimmed.includes('{url}') ? trimmed : null;
}

export function getImageProxyTemplate(): string | null {
  return _imageProxyTemplate;
}

/**
 * Apply the currently active proxy template to `url`. Returns the original
 * URL unchanged when no template is set, when the URL is not http(s), or
 * when substitution fails. This function never throws.
 */
export function applyImageProxy(url: string): string {
  if (!_imageProxyTemplate) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return url;
  try {
    return _imageProxyTemplate.replace('{url}', encodeURIComponent(url));
  } catch {
    return url;
  }
}
