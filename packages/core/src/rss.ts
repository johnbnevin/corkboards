/**
 * RSS feed utilities — pure helpers for hashing and converting RSS items.
 * The actual fetch function stays platform-specific (uses fetch + import.meta.env).
 */
import type { NostrEvent } from '@nostrify/nostrify';

export interface RssFeedResult {
  title: string;
  icon: string;
  items: Array<{ title: string; description: string; link: string; pubDate: string }>;
}

/** Stable numeric hash → short alphanumeric ID for an RSS item. */
export function rssItemId(str: string, feedUrl?: string): string {
  const input = feedUrl ? `${feedUrl}::${str}` : str;
  let h1 = 0, h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) - h1 + c) | 0;
    h2 = ((h2 << 7) ^ (h2 >>> 3) ^ c) | 0;
  }
  return `rss-${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** Convert RSS feed items to pseudo-NostrEvents for unified rendering. */
export function rssItemsToEvents(
  items: RssFeedResult['items'],
  feedTitle: string,
  feedIcon: string,
  feedUrl: string,
): NostrEvent[] {
  return items.map((item, i) => ({
    id: rssItemId(item.link || item.title, feedUrl),
    pubkey: 'rss-feed',
    created_at: (() => {
      if (!item.pubDate) return Math.floor(Date.now() / 1000) - i;
      const ts = new Date(item.pubDate).getTime();
      return isNaN(ts) ? Math.floor(Date.now() / 1000) - i : Math.floor(ts / 1000);
    })(),
    kind: 1,
    tags: [
      ...(item.link ? [['r', item.link]] : []),
      ['feed_name', feedTitle],
      ['feed_icon', feedIcon],
    ],
    content: `**${item.title}**\n\n${item.description}${item.link ? `\n\n${item.link}` : ''}`,
    sig: '',
  } as NostrEvent));
}

// ─── Social media URL → RSS feed conversion ─────────────────────────────────
//
// Only platforms with NATIVE RSS support. No third-party bridges — they get
// rate-limited and break. Twitter/X, Facebook, Instagram, and TikTok actively
// block open access to content. That's why we Nostr.

interface SocialRssResult {
  rssUrl: string;
  platform: string;
  label: string;
}

/**
 * Social URL to RSS conversion is no longer supported — platforms keep
 * breaking their RSS endpoints. Users should paste direct RSS feed URLs
 * (typically ending in .rss, /feed, /rss, or .xml).
 */
export function socialUrlToRss(_url: string): SocialRssResult | null {
  return null;
}

/**
 * Calculate the base time window for fetching based on author count.
 */
export function baseTimeWindow(authorCount: number): number {
  if (authorCount <= 500) return 3600;   // 1 hour
  if (authorCount <= 1000) return 1800;  // 30 minutes
  return 600;                             // 10 minutes
}
