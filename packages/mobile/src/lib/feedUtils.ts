/**
 * Mobile feed utilities: batch author fetching, RSS helpers, and deduplication.
 *
 * Ported from packages/web/src/lib/feedUtils.ts.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import type { useNostr } from './NostrProvider';
import { FEED_KINDS } from '@core/feedConstants';
import { baseTimeWindow } from '@core/rss';
import type { RssFeedResult } from '@core/rss';
import { deduplicateAndSort } from '@core/feedAlgorithms';
import { isUnsafeHost } from '@core/ipUtils';
import { mobileStorage } from '../storage/MmkvStorage';

// Re-export core constants for convenience
export { FEED_PAGE_SIZE_MOBILE, FEED_LOAD_MORE_COUNT, AUTHOR_BATCH_SIZE, MAX_PARALLEL_BATCHES, FEED_KINDS } from '@core/feedConstants';
export { rssItemId, rssItemsToEvents } from '@core/rss';
// Shared pure feed algorithms (were duplicated here and on web).
export { deduplicateAndSort, mergeEvents } from '@core/feedAlgorithms';

// ─── RSS fetch ──────────────────────────────────────────────────────────────

/**
 * Optional last-resort proxy.
 *
 * Web needs a proxy because the browser enforces CORS and almost no feed sends
 * `Access-Control-Allow-Origin`. React Native has no such restriction — `fetch`
 * talks to the origin directly — so routing mobile RSS through corkboards.me was
 * a chokepoint with no technical justification: every feed the user subscribes
 * to was disclosed to one host, on every refresh, and the whole RSS feature died
 * whenever that one host did. Mobile now fetches feeds directly and only falls
 * back to the proxy when the user has explicitly opted in (a feed behind
 * Cloudflare or an origin that blocks mobile user-agents is the real case).
 */
const RSS_PROXY = 'https://corkboards.me/rss-proxy.php';
/** Opt-in flag. Off by default — the proxy sees every feed URL routed through it. */
export const RSS_PROXY_FALLBACK_KEY = 'corkboard:rss-proxy-fallback';

export function isRssProxyFallbackEnabled(): boolean {
  return mobileStorage.getSync(RSS_PROXY_FALLBACK_KEY) === 'true';
}

export function setRssProxyFallbackEnabled(enabled: boolean): void {
  mobileStorage.setSync(RSS_PROXY_FALLBACK_KEY, enabled ? 'true' : 'false');
}

/** Feeds larger than this are truncated rather than parsed whole (mobile RAM). */
const MAX_FEED_BYTES = 2_000_000;

/**
 * Minimal RSS 2.0 / Atom reader.
 *
 * React Native has no DOMParser and pulling an XML library in for four fields
 * would be more code than this. It reads only what the feed card renders —
 * title, description, link, date — and every extracted string is HTML-stripped
 * and entity-decoded here, then HTML-escaped again by `rssItemsToEvents` in
 * @core/rss before it reaches the UI.
 */
function unwrapCdata(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    // `&amp;` LAST so `&amp;lt;` decodes to the literal text "&lt;" rather
    // than being re-decoded into a `<` that could reopen a stripped tag.
    .replace(/&amp;/gi, '&');
}

/** Unwrap CDATA, drop markup, decode entities, collapse whitespace. */
function plainText(raw: string): string {
  return decodeEntities(unwrapCdata(raw).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** First non-empty text content among the given element names. */
function tagText(xml: string, ...names: string[]): string {
  for (const name of names) {
    const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml);
    const text = match ? plainText(match[1]) : '';
    if (text) return text;
  }
  return '';
}

/** Atom puts the permalink in `<link href="…" rel="alternate"/>`, not in text. */
function linkHref(xml: string): string {
  for (const tag of xml.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (rel && rel !== 'alternate') continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (href) return decodeEntities(href).trim();
  }
  return '';
}

function parseFeedXml(xml: string, maxItems: number, feedDomain: string): RssFeedResult | null {
  const entries = xml.match(/<(?:\w+:)?(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:\w+:)?(?:item|entry)>/gi);
  if (!entries || entries.length === 0) return null;

  // Channel title = the first title outside any item; take the document head.
  const head = xml.slice(0, xml.search(/<(?:\w+:)?(?:item|entry)\b/i));
  const items = entries.slice(0, maxItems).map((entry) => ({
    title: tagText(entry, 'title'),
    description: tagText(entry, 'description', 'summary', 'content'),
    link: tagText(entry, 'link') || linkHref(entry),
    pubDate: tagText(entry, 'pubDate', 'published', 'updated', 'date'),
  }));

  return {
    title: tagText(head, 'title') || feedDomain,
    // No icon on the direct path. The proxy inlined the origin's favicon as a
    // data: URI; fetching it here would be a second request per feed, and a
    // third-party favicon service would enumerate the user's subscriptions —
    // exactly the leak this change removes. Empty = the card shows no icon.
    icon: '',
    items,
  };
}

/** Feeds must be plain https to a routable host — no http, no LAN/loopback SSRF. */
function isFetchableFeedUrl(feedUrl: string): boolean {
  try {
    const url = new URL(feedUrl);
    return url.protocol === 'https:' && !isUnsafeHost(url.hostname);
  } catch { return false; }
}

async function fetchRssDirect(feedUrl: string, maxItems: number, feedDomain: string): Promise<RssFeedResult | null> {
  if (!isFetchableFeedUrl(feedUrl)) {
    if (__DEV__) console.warn('[rss] Refusing to fetch', feedUrl);
    return null;
  }
  const response = await fetch(feedUrl, {
    headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (__DEV__) console.warn('[rss] HTTP', response.status, 'for', feedUrl);
    return null;
  }
  const text = (await response.text()).slice(0, MAX_FEED_BYTES);
  return parseFeedXml(text, maxItems, feedDomain);
}

async function fetchRssViaProxy(feedUrl: string, maxItems: number, feedDomain: string): Promise<RssFeedResult | null> {
  const url = `${RSS_PROXY}?url=${encodeURIComponent(feedUrl)}&max=${maxItems}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch {
    if (__DEV__) console.warn('[rss] Non-JSON proxy response for', feedUrl);
    return null;
  }
  if (!response.ok || data.error || !(data.items as unknown[])?.length) {
    if (data.error && __DEV__) console.warn('[rss] Proxy error for', feedUrl, data.error);
    return null;
  }
  return {
    title: (data.title as string) || feedDomain,
    // Icon is the proxy-inlined data: URI (feed origin's own favicon).
    // No third-party favicon fallback — that would enumerate the user's
    // RSS subscriptions to an external service. Empty = no icon.
    icon: (data.icon as string) || '',
    items: data.items as RssFeedResult['items'],
  };
}

/**
 * Fetch and parse an RSS/Atom feed.
 *
 * Direct fetch first (no CORS in React Native, so no proxy is needed and none
 * of the user's subscriptions leak to a third party); the corkboards.me proxy
 * is tried only for feeds that fail directly AND only when the user has turned
 * the fallback on.
 */
export async function fetchRssFeed(feedUrl: string, maxItems = 20): Promise<RssFeedResult | null> {
  let feedDomain = '';
  try { feedDomain = new URL(feedUrl).hostname.replace('www.', ''); } catch { /* ignore */ }

  try {
    const direct = await fetchRssDirect(feedUrl, maxItems, feedDomain);
    if (direct && direct.items.length > 0) {
      if (__DEV__) console.log('[rss] Loaded', direct.items.length, 'items directly from', feedUrl);
      return direct;
    }
  } catch (err) {
    if (__DEV__) console.warn('[rss] Direct fetch failed for', feedUrl, err instanceof Error ? err.message : err);
  }

  if (!isRssProxyFallbackEnabled()) return null;

  try {
    const proxied = await fetchRssViaProxy(feedUrl, maxItems, feedDomain);
    if (proxied) {
      if (__DEV__) console.log('[rss] Loaded', proxied.items.length, 'items via proxy from', feedUrl);
      return proxied;
    }
  } catch (err) {
    if (__DEV__) console.warn('[rss] Proxy fetch failed for', feedUrl, err instanceof Error ? err.message : err);
  }

  return null;
}

// Max authors per relay query to avoid silent truncation by relays
const MAX_AUTHORS_PER_QUERY = 500;

// ─── Batch author fetch ─────────────────────────────────────────────────────

export interface BatchFetchOpts {
  nostr: ReturnType<typeof useNostr>['nostr'];
  authors: string[];
  kinds?: number[];
  /** Note limit per fetch. */
  limit: number;
  /** Per-fetch timeout ms (default 15000). */
  timeout?: number;
  /** Oldest timestamp for pagination (load older). */
  until?: number;
  /** Newest timestamp for pagination (load newer or initial load). */
  since?: number;
  /** Time window multiplier for initial load (1x, 2x, 3x). */
  multiplier?: number;
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Fetch notes from all authors in a SINGLE relay query (up to 500 authors).
 *
 * Base time windows:
 * - 0-500 authors: 1 hour (3600s)
 * - 501-1000 authors: 30 minutes (1800s)
 * - 1000+ authors: 10 minutes (600s)
 *
 * Multiplier (1x/2x/3x) multiplies the base window for initial load.
 * "Load more" clicks extend the window additively (not multiplicative).
 */
export async function batchFetchByAuthors(opts: BatchFetchOpts): Promise<NostrEvent[]> {
  const {
    nostr,
    authors,
    kinds = [...FEED_KINDS].filter(k => k !== 5),
    limit,
    timeout = 15_000,
    until,
    since,
    multiplier = 1,
    onProgress,
  } = opts;

  if (authors.length === 0) return [];

  // Calculate base time window based on author count
  const baseWindowSeconds = baseTimeWindow(authors.length);

  const now = Math.floor(Date.now() / 1000);

  // If since is provided (load more), use that directly
  // Otherwise calculate from multiplier (initial load)
  const effectiveSince = since ?? (now - (baseWindowSeconds * multiplier));

  if (__DEV__) {
    const effectiveWindowMinutes = (baseWindowSeconds * multiplier) / 60;
    if (__DEV__) console.log(`[batchFetch] Query for ${authors.length} authors, window: ${effectiveWindowMinutes}min (${multiplier}x)`);
  }

  onProgress?.(0, 1);

  try {
    // Chunk authors to avoid relay-side truncation (some relays cap at 100-500)
    const chunks: string[][] = [];
    for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_QUERY) {
      chunks.push(authors.slice(i, i + MAX_AUTHORS_PER_QUERY));
    }

    const allEvents = await Promise.all(
      chunks.map(chunk =>
        nostr.query(
          [{
            kinds,
            authors: chunk,
            limit,
            since: effectiveSince,
            ...(until !== undefined ? { until } : {}),
          }],
          { signal: AbortSignal.timeout(timeout) },
        ).catch((err) => {
          console.warn('[batchFetch] Chunk query failed:', err);
          return [] as NostrEvent[];
        })
      )
    );

    const events = allEvents.flat();
    onProgress?.(1, 1);
    if (__DEV__) console.log(`[batchFetch] Got ${events.length} events from ${authors.length} authors (${chunks.length} chunks)`);

    // Deduplicate and sort
    return deduplicateAndSort(events);
  } catch (err) {
    console.warn('[batchFetch] Query failed:', err);
    onProgress?.(1, 1);
    return [];
  }
}

