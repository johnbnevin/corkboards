/**
 * Blossom media helpers — shared by web and mobile.
 *
 * Blossom (BUD-01) addresses every blob by its sha256 hash: a file lives at
 * `https://<server>/<sha256>[.ext]`. Because the hash is content-addressed and
 * stable across servers, a blob uploaded (or mirrored) to several servers can
 * be fetched from any of them using the same path.
 *
 * We use this for two things:
 *   1. Upload mirroring — push each blob to several servers for redundancy
 *      (see useUploadFile.ts on web + mobile).
 *   2. Render-time fallback — when an <img> fails to load from the server in the
 *      note, retry the same hash on other known servers before giving up
 *      (see MediaLink.tsx on web + mobile). When the note carries a NIP-92
 *      `imeta` tag with the blob's sha256 (`x`) and/or explicit `fallback`
 *      URLs, we can rebuild the blob URL on every known server even when the
 *      primary URL isn't a flat `/(sha256)` path (e.g. nostr.build nested
 *      paths) — see resolveMediaSources.
 */
import { shouldRejectUrl } from './imageUtils';

/**
 * Known Blossom servers, in fallback priority order (most reliable first).
 * Used both as the default upload set and as the render-time fallback set.
 * Each entry is a base origin ending in `/`.
 */
export const KNOWN_BLOSSOM_SERVERS = [
  'https://blossom.band/',
  'https://blossom.primal.net/',
  'https://blossom.yakihonne.com/',
  'https://cdn.sovbit.host/',
  'https://blossom.f7z.io/',
  'https://blossom.ditto.pub/',
  'https://nostr.download/',
] as const;

/** A blossom path is a bare 64-char sha256, optionally with a file extension. */
const BLOSSOM_HASH_RE = /^([0-9a-f]{64})(\.[a-z0-9]+)?$/i;

export interface BlossomRef {
  /** Lowercase sha256 hex of the blob */
  hash: string;
  /** File extension including the dot (e.g. ".png"), or "" if none */
  ext: string;
}

/**
 * Parse a URL as a Blossom blob reference. Returns the sha256 hash + extension
 * when the URL's LAST path segment is a bare `<sha256>[.ext]`, else null.
 *
 * Flat paths (`https://host/<sha256>.ext`) are classic Blossom. Nested
 * content-addressed paths (e.g. nostrmedia's `/p/<pubkey>/<sha256>.mp4`) also
 * carry the blob hash in their final segment, so the same blob can be rebuilt
 * on other servers from that hash — it's the hash that's content-addressed,
 * not the path shape.
 */
export function extractBlossomRef(url: string): BlossomRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const m = segments[segments.length - 1].match(BLOSSOM_HASH_RE);
  if (!m) return null;
  return { hash: m[1].toLowerCase(), ext: m[2] ? m[2].toLowerCase() : '' };
}

/** True when the URL looks like a content-addressed Blossom blob URL. */
export function isBlossomUrl(url: string): boolean {
  return extractBlossomRef(url) !== null;
}

/**
 * Build blob URLs for a given sha256 hash on every server, in priority order.
 * The hash-first primitive: works regardless of what the primary URL's path
 * looked like, so a note that records the sha256 (NIP-92 `x`) can fall back
 * across servers even when the primary URL is a nested/non-flat path.
 * Returns [] if the hash isn't a well-formed sha256.
 */
export function getBlossomUrlsForHash(
  hash: string,
  ext: string = '',
  servers: readonly string[] = KNOWN_BLOSSOM_SERVERS,
): string[] {
  if (!/^[0-9a-f]{64}$/i.test(hash)) return [];
  const h = hash.toLowerCase();
  let e = ext ? ext.toLowerCase() : '';
  if (e && !e.startsWith('.')) e = `.${e}`;
  const out: string[] = [];
  for (const base of servers) {
    out.push(`${base.replace(/\/+$/, '')}/${h}${e}`);
  }
  return out;
}

/**
 * Build fallback URLs for a Blossom blob on other known servers. Given a blob
 * URL, returns the same `<hash><ext>` path on every known server except the one
 * already in the URL, in priority order. Returns [] for non-Blossom URLs.
 */
export function getBlossomFallbackUrls(
  url: string | undefined | null,
  servers: readonly string[] = KNOWN_BLOSSOM_SERVERS,
): string[] {
  if (!url) return [];
  const ref = extractBlossomRef(url);
  if (!ref) return [];

  let originHost = '';
  try {
    originHost = new URL(url).hostname;
  } catch {
    /* ref already validated the URL, but be defensive */
  }

  return getBlossomUrlsForHash(ref.hash, ref.ext, servers).filter((u) => {
    try {
      return new URL(u).hostname !== originHost;
    } catch {
      return true;
    }
  });
}

/** Structured contents of a NIP-92 `imeta` tag. */
export interface ImetaData {
  /** Primary media URL (the `url` field). */
  url: string;
  /** sha256 hex of the blob (the `x` field), if present. */
  sha256?: string;
  /** MIME type (the `m` field), if present. */
  mime?: string;
  /** Poster/preview image URL (the `image` field), if present. */
  image?: string;
  /** Author-declared alternate URLs (every `fallback` field). */
  fallbacks: string[];
}

/**
 * Parse one NIP-92 `imeta` tag array (`['imeta', 'url …', 'x …', …]`) into
 * structured data. Fields are space-delimited `key value` strings. Returns null
 * when the tag carries no `url`.
 */
export function parseImetaTag(tag: readonly string[]): ImetaData | null {
  if (!Array.isArray(tag) || tag[0] !== 'imeta') return null;
  let url = '';
  let sha256: string | undefined;
  let mime: string | undefined;
  let image: string | undefined;
  const fallbacks: string[] = [];
  for (let i = 1; i < tag.length; i++) {
    const entry = tag[i];
    if (typeof entry !== 'string') continue;
    if (entry.startsWith('url ')) url = url || entry.slice(4).trim();
    else if (entry.startsWith('x ')) {
      const v = entry.slice(2).trim();
      if (/^[0-9a-f]{64}$/i.test(v)) sha256 = v.toLowerCase();
    } else if (entry.startsWith('m ')) mime = entry.slice(2).trim();
    else if (entry.startsWith('image ')) image = image || entry.slice(6).trim();
    else if (entry.startsWith('fallback ')) {
      const v = entry.slice(9).trim();
      if (v) fallbacks.push(v);
    }
  }
  if (!url) return null;
  return { url, sha256, mime, image, fallbacks };
}

/**
 * Resolve the ordered, deduped, SSRF-gated list of URLs to try for one media
 * item, best source first:
 *   1. the primary URL,
 *   2. any author-declared NIP-92 `fallback` URLs,
 *   3. the blob rebuilt on every known server from its sha256 (or, for old
 *      notes without a sha256, from a flat primary URL via getBlossomFallbackUrls).
 *
 * This is the single source of truth for both MediaLink branches and avatars.
 * Unsafe/private hosts are dropped (SSRF) using the shared shouldRejectUrl gate.
 */
export function resolveMediaSources(input: {
  url: string;
  sha256?: string;
  /** Extension override (e.g. ".png"); else derived from url/fallbacks. */
  ext?: string;
  /** Author-declared NIP-92 fallback URLs. */
  fallbacks?: string[];
  servers?: readonly string[];
  /** SSRF gate class; avatars are stricter (https-only). Default 'media'. */
  rejectType?: 'avatar' | 'media';
  /** Set false to skip SSRF gating (rarely needed). Default true. */
  rejectUnsafe?: boolean;
}): string[] {
  const {
    url,
    sha256,
    fallbacks = [],
    servers = KNOWN_BLOSSOM_SERVERS,
    rejectType = 'media',
    rejectUnsafe = true,
  } = input;

  const ext = input.ext
    ?? extractBlossomRef(url)?.ext
    ?? (fallbacks.map((f) => extractBlossomRef(f)?.ext).find(Boolean) || '');

  const reconstructed = sha256
    ? getBlossomUrlsForHash(sha256, ext, servers)
    : getBlossomFallbackUrls(url, servers);

  const ordered = [url, ...fallbacks, ...reconstructed];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of ordered) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (rejectUnsafe && shouldRejectUrl(candidate, rejectType)) continue;
    out.push(candidate);
  }
  return out;
}
