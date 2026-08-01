/**
 * Video-title proxy — fetches YouTube video titles (oEmbed) through a
 * user-configured endpoint template, so the party that learns which videos
 * appear in the user's feed is chosen by the USER, not by us.
 *
 * A Nostr relay cannot do this job — relays only store and serve events, they
 * have no HTTP-fetch capability — so the closest thing to "my relay of
 * choice" is "my endpoint of choice": any server the user trusts that can
 * pass a JSON GET through (a self-hosted copy of rss-proxy.php, a friend's,
 * or corkboards.me — all equally valid, none privileged).
 *
 * Two-piece design, mirroring imageProxy.ts:
 *   - This pure helper builds/validates URLs and does the fetch given a
 *     template.
 *   - Each platform reads its persisted setting and calls
 *     `setTitleProxyTemplate(...)` once on startup.
 *
 * Opt-in: when the template is empty/null, NO request is made to anyone and
 * no title is shown — the "no request reaches any provider until the user
 * acts" invariant holds exactly as before.
 *
 * The `{url}` placeholder receives the full oEmbed URL
 * (https://www.youtube.com/oembed?url=…&format=json), not the bare video
 * URL, so any generic JSON pass-through proxy works without knowing what
 * oEmbed is.
 */

let _titleProxyTemplate: string | null = null;

/**
 * Validate a title-proxy template for the settings UI. Returns a
 * human-readable reason it can't be used, or `null` when it's fine
 * (including when empty, which simply means "titles disabled").
 * Same rules and wording as the image proxy so both inputs behave alike.
 */
export function validateTitleProxyTemplate(template: string): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null; // empty = disabled
  if (!trimmed.includes('{url}')) return 'Template must include {url}';
  // Require https — an http:// endpoint would broadcast every video the user
  // sees to any observer on the path, strictly worse than showing no title.
  if (!/^https:\/\//i.test(trimmed)) return 'Template must start with https://';
  return null;
}

/**
 * Set the active template. Use `null` or empty string to disable.
 * An invalid template disables titles rather than being applied.
 */
export function setTitleProxyTemplate(template: string | null | undefined): void {
  const trimmed = template?.trim();
  if (!trimmed || validateTitleProxyTemplate(trimmed) !== null) {
    _titleProxyTemplate = null;
    return;
  }
  _titleProxyTemplate = trimmed;
}

export function getTitleProxyTemplate(): string | null {
  return _titleProxyTemplate;
}

/** Hosts whose URLs we're willing to ask YouTube's oEmbed endpoint about. */
function isYouTubeVideoUrl(videoUrl: string): boolean {
  try {
    const u = new URL(videoUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return (
      /(^|\.)youtube\.com$/.test(u.hostname) ||
      /(^|\.)youtube-nocookie\.com$/.test(u.hostname) ||
      u.hostname === 'youtu.be'
    );
  } catch {
    return false;
  }
}

/**
 * Build the oEmbed lookup URL for a YouTube video URL, or `null` when the
 * URL isn't a YouTube one (we never ask about non-YouTube URLs — the feature
 * is scoped to the "Open YouTube in browser" bar).
 */
export function buildYouTubeOembedUrl(videoUrl: string): string | null {
  if (!isYouTubeVideoUrl(videoUrl)) return null;
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
}

/**
 * Wrap an oEmbed URL in the active template. Returns `null` when no template
 * is configured — callers MUST treat null as "do not fetch at all".
 */
export function applyTitleProxy(oembedUrl: string): string | null {
  if (!_titleProxyTemplate) return null;
  try {
    return _titleProxyTemplate.replace('{url}', encodeURIComponent(oembedUrl));
  } catch {
    return null;
  }
}

export interface YouTubeOembedInfo {
  title: string;
  authorName: string;
}

/**
 * Fetch a YouTube video's title through the user-configured proxy.
 *
 * Returns `null` — and, critically, performs NO network request — when no
 * template is configured or the URL isn't a YouTube video. Also returns
 * `null` on any fetch/parse failure; a missing title is never an error the
 * UI needs to surface. Never throws.
 *
 * `fetchFn` is injectable for tests.
 */
export async function fetchYouTubeOembed(
  videoUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<YouTubeOembedInfo | null> {
  const oembedUrl = buildYouTubeOembedUrl(videoUrl);
  if (!oembedUrl) return null;
  const proxied = applyTitleProxy(oembedUrl);
  if (!proxied) return null;

  try {
    const res = await fetchFn(proxied);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const title = (body as Record<string, unknown>).title;
    if (typeof title !== 'string' || title.length === 0) return null;
    const authorName = (body as Record<string, unknown>).author_name;
    return {
      // Same caps rss-proxy.php enforces server-side, applied again here so a
      // third-party proxy can't balloon the bar.
      title: title.slice(0, 300),
      authorName: typeof authorName === 'string' ? authorName.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}
