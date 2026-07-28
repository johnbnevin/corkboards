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

/** BIP-173 checksum step. Operates on the 5-bit value stream, generator
 *  constants straight from the spec's reference implementation. */
function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

/** BIP-173 HRP expansion: high bits, a zero separator, then low bits. */
function bech32HrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    // The HRP is restricted to US-ASCII 33–126; anything else can't be encoded.
    if (c < 33 || c > 126) return [];
    high.push(c >>> 5);
    low.push(c & 31);
  }
  return [...high, 0, ...low];
}

/** Decode a bech32 string into its human-readable prefix + 5-bit data words.
 *  Does NOT enforce the 90-char BIP-173 length cap — LNURL intentionally
 *  exceeds it. The CHECKSUM IS VERIFIED and a mismatch fails closed: the
 *  checksum is the only thing standing between a typo'd or tampered `lud06` and
 *  a silently different destination URL, and the payload here comes from an
 *  untrusted kind-0 profile. Stripping it without checking it, as this used to,
 *  meant a single flipped character could decode to a working URL on some other
 *  host and the user would zap it without noticing. */
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

  const expanded = bech32HrpExpand(hrp);
  if (expanded.length === 0) return null; // non-ASCII HRP
  // Original bech32 (BIP-173) constant. LNURL uses bech32, not bech32m, so a
  // bech32m-encoded string is correctly rejected here rather than half-decoded.
  if (bech32Polymod([...expanded, ...words]) !== 1) return null;

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

/**
 * A lud16 domain, as it may appear in the URL we build. Deliberately narrow:
 * letters/digits/dots/hyphens, with an optional port.
 *
 * The previous check only rejected `/` and `\`, which let `evil.com?x=`,
 * `evil.com#`, `evil.com:@attacker.com` and similar junk straight into a
 * template string — where the `?`/`#` starts a query or fragment and the whole
 * `.well-known/lnurlp/…` path we thought we were requesting becomes decoration
 * on someone else's URL. `isUnsafeHost` was then run on that raw string rather
 * than on a parsed hostname, so it was answering a question about the wrong
 * value. Everything is now parsed with `new URL` and validated on `hostname`.
 */
const LUD16_DOMAIN_RE = /^[a-z0-9.-]+(:\d{1,5})?$/;

/** Convert a lud16 lightning address (`name@domain`) to its LNURL-pay URL. */
export function lud16ToLnurlPayUrl(lud16: string): string | null {
  const addr = lud16.trim();
  const atIdx = addr.lastIndexOf('@');
  if (atIdx < 1) return null;
  const name = addr.slice(0, atIdx).trim();
  const domain = addr.slice(atIdx + 1).trim().toLowerCase();
  if (!name || !domain) return null;
  if (!domain.includes('.') || !LUD16_DOMAIN_RE.test(domain)) return null;

  const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Re-derive the authority from the parsed URL: this is the only value that is
  // certainly what a fetch will actually contact.
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (isUnsafeHost(parsed.hostname)) return null; // block IP-literal / private-host lud16
  return parsed.toString();
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
