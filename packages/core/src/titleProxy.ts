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
 * The corkboards-operated endpoint, offered as a one-click option in
 * settings. POST mode (no {url}): the lookup travels in the request body, so
 * it never appears in web-server access logs — the app's proxy code keeps no
 * logs of its own, and the host's standard ~7-day access logs record only
 * that an IP used the title service, never which videos.
 */
export const CORKBOARDS_TITLE_PROXY = 'https://corkboards.me/youtube-proxy.php';

/**
 * Validate a title-proxy endpoint for the settings UI. Returns a
 * human-readable reason it can't be used, or `null` when it's fine
 * (including when empty, which simply means "titles disabled").
 *
 * Two accepted forms:
 *   - a template containing `{url}` — GET substitution, for generic
 *     pass-through proxies (the lookup appears in that host's query logs);
 *   - a plain URL without `{url}` — POST mode, the lookup goes in the
 *     request body and stays out of access logs (youtube-proxy.php style).
 */
export function validateTitleProxyTemplate(template: string): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null; // empty = disabled
  // Require https — an http:// endpoint would broadcast every video the user
  // sees to any observer on the path, strictly worse than showing no title.
  if (!/^https:\/\//i.test(trimmed)) return 'Endpoint must start with https://';
  if (!trimmed.includes('{url}')) {
    // POST mode: must at least parse as a URL.
    try { new URL(trimmed); } catch { return 'Enter a valid https:// URL (or a template with {url})'; }
  }
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
 * Resolve the active endpoint for an oEmbed URL. Returns `null` when no
 * template is configured — callers MUST treat null as "do not fetch at all".
 *
 * GET mode (template contains {url}): the request URL with the lookup
 * substituted in. POST mode (plain URL): the endpoint itself, with the
 * lookup to be sent as the request body.
 */
export function applyTitleProxy(
  oembedUrl: string,
): { url: string; method: 'GET' | 'POST' } | null {
  if (!_titleProxyTemplate) return null;
  if (!_titleProxyTemplate.includes('{url}')) {
    return { url: _titleProxyTemplate, method: 'POST' };
  }
  try {
    return {
      url: _titleProxyTemplate.replace('{url}', encodeURIComponent(oembedUrl)),
      method: 'GET',
    };
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
    // POST body is plain text (the oEmbed URL) — a CORS "simple request", no
    // preflight, and the lookup stays out of web-server access logs.
    const res = proxied.method === 'POST'
      ? await fetchFn(proxied.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: oembedUrl,
        })
      : await fetchFn(proxied.url);
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
