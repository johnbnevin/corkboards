/**
 * NIP-99 classified listings (kind 30402) + the Gamma Markets `market-spec`
 * extension that the Open Markets / OpenMarkets crew (Shopstr, Cypher, Plebeian,
 * Conduit) recommend — merged into NIP-99 via nostr-protocol/nips PR #1784.
 *
 * We reuse the standard kind rather than inventing anything. A "store" in this
 * model is a merchant npub + kind 0 profile + kind 30402 listings grouped by
 * kind 30405 collections — see the store-corkboard project note.
 *
 * Pure parsing only (no DOM/React) so web + mobile share one source of truth.
 */
import type { NostrEvent } from '@nostrify/nostrify';

/** NIP-99 classified listing / draft. */
export const LISTING_KIND = 30402;
export const LISTING_DRAFT_KIND = 30403;
/** Gamma Markets companion kinds. */
export const COLLECTION_KIND = 30405;
export const SHIPPING_OPTION_KIND = 30406;
export const REVIEW_KIND = 31555;

export interface ParsedListing {
  title: string;
  summary?: string;
  /** Human-formatted price, e.g. "20 USD" or "1000 sat/month". */
  price: string | null;
  priceRaw?: { amount: string; currency: string; frequency?: string };
  /** Image URLs, ordered by the Gamma image tag's order field when present. */
  images: string[];
  location?: string;
  /** NIP-99 lifecycle: 'active' | 'sold'. */
  status?: string;
  /** Gamma visibility: 'on-sale' | 'pre-order' | 'hidden'. */
  visibility?: string;
  /** Gamma stock quantity (undefined if not specified / non-numeric). */
  stock?: number;
  /** Gamma product spec key/value pairs (e.g. ['color','red']). */
  specs: [string, string][];
}

function tagVal(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(t => t[0] === name)?.[1];
}

/** Format a NIP-99 price tag: ['price', amount, currency, frequency?]. */
export function formatListingPrice(
  priceRaw: { amount: string; currency: string; frequency?: string } | undefined,
): string | null {
  if (!priceRaw) return null;
  const freq = priceRaw.frequency ? `/${priceRaw.frequency}` : '';
  return `${priceRaw.amount} ${priceRaw.currency}${freq}`.trim();
}

/** Parse a kind-30402 listing (with Gamma extensions) into structured fields. */
export function parseListing(event: NostrEvent): ParsedListing {
  const title = tagVal(event, 'title') || 'Listing';
  const summary = tagVal(event, 'summary');
  const location = tagVal(event, 'location');
  const status = tagVal(event, 'status');
  const visibility = tagVal(event, 'visibility');

  const stockStr = tagVal(event, 'stock');
  const stock = stockStr !== undefined && /^\d+$/.test(stockStr) ? parseInt(stockStr, 10) : undefined;

  const priceTag = event.tags.find(t => t[0] === 'price');
  const priceRaw = priceTag?.[1]
    ? { amount: priceTag[1], currency: priceTag[2] || '', frequency: priceTag[3] || undefined }
    : undefined;

  // Gamma image tags: ['image', url, dimensions?, order?]. Sort by the order
  // field when present so galleries render in the merchant's intended order.
  const imageTags = event.tags.filter(t => t[0] === 'image' && typeof t[1] === 'string' && t[1]);
  imageTags.sort((a, b) => (parseInt(a[3] || '0', 10)) - (parseInt(b[3] || '0', 10)));
  const images = imageTags.map(t => t[1]);
  if (images.length === 0) {
    // Fall back to the first imeta (NIP-92) url for listings that use imeta.
    for (const t of event.tags) {
      if (t[0] !== 'imeta') continue;
      for (let i = 1; i < t.length; i++) {
        const entry = t[i];
        if (typeof entry === 'string' && entry.startsWith('url ')) { images.push(entry.slice(4)); break; }
      }
    }
  }

  const specs = event.tags
    .filter(t => t[0] === 'spec' && typeof t[1] === 'string' && typeof t[2] === 'string')
    .map(t => [t[1], t[2]] as [string, string]);

  return {
    title, summary,
    price: formatListingPrice(priceRaw), priceRaw,
    images, location, status, visibility, stock, specs,
  };
}
