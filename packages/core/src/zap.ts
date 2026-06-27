/**
 * Zap endpoint resolution (NIP-57) — shared by web and mobile.
 *
 * A profile (kind 0) can advertise its LNURL-pay endpoint two ways:
 *   - `lud16`: a lightning address `name@domain` (the common case)
 *   - `lud06`: a bech32-encoded LNURL (`lnurl1…`) that decodes to the URL
 *
 * The zap hooks previously read ONLY `lud16`, so anyone who set just `lud06`
 * (older setups, some wallets) looked like they had "no lightning address" and
 * couldn't be zapped even though their endpoint works. `resolveZapEndpoint`
 * accepts either, and is tolerant of a value placed in the "wrong" field.
 *
 * Self-contained bech32 decoder so @corkboards/core stays dependency-free and
 * the same logic runs identically on web and React Native.
 *
 * SSRF NOTE: every endpoint here is derived from an UNTRUSTED, attacker-
 * controllable kind-0 profile (`lud16`/`lud06`). A hostile profile could point
 * at `http://169.254.169.254/…` (cloud metadata) or a private/LAN address to
 * make the user's client fetch internal resources — and, worse, POST a *signed*
 * kind-9734 zap request to an arbitrary host. So we require https and run every
 * resolved host through `isUnsafeHost` here, and callers must validate the
 * server-supplied `callback` URL the same way before the second fetch.
 */
import { isUnsafeHost } from './ipUtils';

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Decode a bech32 string into its human-readable prefix + 5-bit data words.
 *  Does NOT enforce the 90-char BIP-173 length cap — LNURL intentionally
 *  exceeds it. Checksum is stripped but not verified (lenient). */
function bech32Decode(input: string): { hrp: string; words: number[] } | null {
  // Reject mixed-case (invalid per spec); accept all-lower or all-upper.
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) return null;
  const s = input.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const words: number[] = [];
  for (let i = sep + 1; i < s.length; i++) {
    const v = BECH32_CHARSET.indexOf(s[i]);
    if (v === -1) return null;
    words.push(v);
  }
  if (words.length < 6) return null;
  return { hrp, words: words.slice(0, words.length - 6) };
}

/** Regroup 5-bit words into 8-bit bytes (BIP-173 convertbits, 5→8, no pad). */
function wordsToBytes(words: number[]): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << 8) - 1;
  for (const value of words) {
    if (value < 0 || value >> 5 !== 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & maxv);
    }
  }
  // Reject if leftover bits encode non-zero padding (malformed input).
  if (bits >= 5 || ((acc << (8 - bits)) & maxv)) return null;
  return out;
}

/**
 * Validate a URL as a safe LNURL-pay fetch target: https only, and not a
 * private/loopback/link-local/metadata host. Returns the URL when safe, else
 * null. Use this on BOTH the resolved endpoint and the server-supplied
 * `callback` to block SSRF / signed-event exfiltration to internal hosts.
 */
export function isSafeZapUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return !isUnsafeHost(u.hostname);
}

/** Convert a lud16 lightning address (`name@domain`) to its LNURL-pay URL. */
export function lud16ToLnurlPayUrl(lud16: string): string | null {
  const addr = lud16.trim();
  const atIdx = addr.lastIndexOf('@');
  if (atIdx < 1) return null;
  const name = addr.slice(0, atIdx).trim();
  const domain = addr.slice(atIdx + 1).trim().toLowerCase();
  if (!name || !domain) return null;
  if (domain.includes('/') || domain.includes('\\') || !domain.includes('.')) return null;
  if (isUnsafeHost(domain)) return null; // block IP-literal / private-host lud16
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
}

/** Decode a lud06 bech32 LNURL (`lnurl1…`) into its https URL (SSRF-checked). */
export function lud06ToLnurlPayUrl(lud06: string): string | null {
  const input = lud06.trim();
  if (!/^lnurl1/i.test(input)) return null;
  const decoded = bech32Decode(input);
  if (!decoded || decoded.hrp !== 'lnurl') return null;
  const bytes = wordsToBytes(decoded.words);
  if (!bytes || bytes.length === 0) return null;
  let url = '';
  for (const b of bytes) url += String.fromCharCode(b); // URLs are ASCII
  // Require https + a non-private host. (Plaintext http LNURL would leak
  // payment metadata anyway; onion services aren't reachable from this client.)
  if (!isSafeZapUrl(url)) return null;
  return url;
}

/**
 * Resolve a profile's LNURL-pay endpoint from its metadata. Prefers `lud16`,
 * falls back to `lud06`, and tolerates a value stored in the opposite field
 * (e.g. an `lnurl1…` placed in `lud16`). Returns the endpoint URL or null.
 */
export function resolveZapEndpoint(
  metadata: { lud16?: string; lud06?: string } | undefined | null,
): string | null {
  if (!metadata) return null;
  const lud16 = typeof metadata.lud16 === 'string' ? metadata.lud16.trim() : '';
  const lud06 = typeof metadata.lud06 === 'string' ? metadata.lud06.trim() : '';

  for (const candidate of [lud16, lud06]) {
    if (!candidate) continue;
    const url = candidate.includes('@')
      ? lud16ToLnurlPayUrl(candidate)
      : lud06ToLnurlPayUrl(candidate);
    if (url) return url;
  }
  return null;
}
