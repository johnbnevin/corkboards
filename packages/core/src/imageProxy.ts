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
 * Validate a proxy template for the settings UI. Returns a human-readable
 * reason it can't be used, or `null` when it's fine (including when empty,
 * which simply means "proxy disabled").
 *
 * Shared by web and mobile settings so both reject the same inputs with the
 * same wording, and so `setImageProxyTemplate` below can't quietly drop a
 * template the UI told the user it had saved.
 */
export function validateImageProxyTemplate(template: string): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null; // empty = disabled
  if (!trimmed.includes('{url}')) return 'Template must include {url}';
  // Require https. The whole point of the proxy is to keep the user's IP away
  // from arbitrary image hosts; an http:// template would instead hand every
  // image URL they view to any observer on the path, in cleartext — strictly
  // worse than the no-proxy default. Reject rather than silently downgrade.
  if (!/^https:\/\//i.test(trimmed)) return 'Template must start with https://';
  return null;
}

/**
 * Set the active proxy template. Use `null` or empty string to disable.
 * A template that fails `validateImageProxyTemplate` disables the proxy rather
 * than being applied — URLs then pass through unrewritten (the safe default).
 */
export function setImageProxyTemplate(template: string | null | undefined): void {
  const trimmed = template?.trim();
  if (!trimmed || validateImageProxyTemplate(trimmed) !== null) {
    _imageProxyTemplate = null;
    return;
  }
  _imageProxyTemplate = trimmed;
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
