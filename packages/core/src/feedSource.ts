/**
 * parseFeedSource — classify a raw corkboard-builder input into the kind of feed
 * source it is: a Nostr author (npub/nprofile/hex), a relay (wss/ws), an RSS feed
 * (https/http/bare domain), or a hashtag (#tag).
 *
 * Shared by web and mobile so the corkboard builder behaves identically. Core
 * stays dependency-free: the one piece that needs a real Nostr codec — decoding
 * an npub/nprofile to a hex pubkey — is injected as `decodeNpub` (web and mobile
 * both pass nostr-tools' nip19). Everything else is plain string classification.
 */
export interface FeedSource {
  type: 'relay' | 'rss' | 'pubkey' | 'hashtag';
  value: string;
  /** True when an http:// RSS URL was auto-upgraded to https:// (proxy is https-only). */
  httpsUpgraded?: boolean;
}

/** Returns the hex pubkey for an npub/nprofile, or null if it isn't one. */
export type NpubDecoder = (input: string) => string | null;

export function parseFeedSource(raw: string, decodeNpub: NpubDecoder): FeedSource | null {
  const input = raw.trim();
  if (!input) return null;

  // Hashtag: #bitcoin. Unicode-aware — `\w` is ASCII-only, so `#биткоин` and
  // `#比特币` were rejected outright and there was no way to add a non-Latin
  // hashtag source to a corkboard at all. Same character class as the inline
  // hashtag matcher in noteCategories, so what you can add is what will match.
  if (input.startsWith('#') && input.length > 1 && /^#[\p{L}\p{N}_]+$/u.test(input)) {
    return { type: 'hashtag', value: input.slice(1).toLowerCase() };
  }
  // Relay
  if (input.startsWith('wss://') || input.startsWith('ws://')) {
    return { type: 'relay', value: input };
  }
  // RSS
  if (input.startsWith('https://')) {
    return { type: 'rss', value: input };
  }
  // Feeds are fetched through an https-only proxy — upgrade http→https.
  if (input.startsWith('http://')) {
    return { type: 'rss', value: 'https://' + input.slice('http://'.length), httpsUpgraded: true };
  }
  // Bare domain/URL without a scheme (but not an npub/nprofile) — prepend https.
  if (input.includes('.') && !input.startsWith('npub') && !input.startsWith('nprofile')) {
    return { type: 'rss', value: 'https://' + input };
  }
  // Nostr author: npub / nprofile via the injected decoder, else bare 64-hex.
  const pk = decodeNpub(input);
  if (pk) return { type: 'pubkey', value: pk };
  if (input.length === 64 && /^[0-9a-f]+$/i.test(input)) {
    return { type: 'pubkey', value: input.toLowerCase() };
  }
  return null;
}
