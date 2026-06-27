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
 *      (see MediaLink.tsx on web + mobile).
 */

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
 * when the URL is a flat `https://host/<sha256>[.ext]` path, else null.
 *
 * Hosts with non-flat paths (e.g. nostr.build's nested paths) return null —
 * those aren't content-addressed in a way we can remap across servers.
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
  if (segments.length !== 1) return null;
  const m = segments[0].match(BLOSSOM_HASH_RE);
  if (!m) return null;
  return { hash: m[1].toLowerCase(), ext: m[2] ? m[2].toLowerCase() : '' };
}

/** True when the URL looks like a content-addressed Blossom blob URL. */
export function isBlossomUrl(url: string): boolean {
  return extractBlossomRef(url) !== null;
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

  const out: string[] = [];
  for (const base of servers) {
    let host = '';
    try {
      host = new URL(base).hostname;
    } catch {
      continue;
    }
    if (host === originHost) continue;
    out.push(`${base.replace(/\/+$/, '')}/${ref.hash}${ref.ext}`);
  }
  return out;
}
