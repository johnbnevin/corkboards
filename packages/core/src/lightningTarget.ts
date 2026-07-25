/**
 * lightningTarget — classify an arbitrary scanned/pasted string as something
 * payable over Lightning.
 *
 * QR codes in the wild carry any of these, with or without a `lightning:`
 * scheme prefix, in either case, sometimes wrapped in a BIP-21 style URI:
 *
 *   - a BOLT-11 invoice        `lnbc1500n1p...`      (fixed or open amount)
 *   - an LNURL-pay code        `lnurl1dp68gurn...`
 *   - a lightning address      `alice@example.com`
 *
 * Everything downstream needs to know is which of those it got and the payload
 * in canonical form. Resolving an LNURL/address into an invoice is the caller's
 * job (see `resolveZapEndpoint` / the zap hooks); this module only parses, so it
 * stays pure and testable and can be reused by any platform's scanner.
 *
 * A QR code is untrusted input from outside the app — a sticker on a wall, a
 * screenshot from a stranger — so nothing here is permissive. Unknown schemes,
 * private/IP-literal hosts and malformed bech32 are rejected outright rather
 * than passed along for some later layer to notice.
 */

import type { NostrEvent } from '@nostrify/nostrify';
import { lud06ToLnurlPayUrl, lud16ToLnurlPayUrl } from './zap';

export type LightningTarget =
  /** A BOLT-11 invoice, ready to hand to `pay_invoice`. Lowercased, no prefix. */
  | { kind: 'invoice'; invoice: string; amountSats: number | null }
  /** An LNURL-pay code. `url` is the decoded, SSRF-checked https endpoint. */
  | { kind: 'lnurl'; lnurl: string; url: string }
  /** A lightning address. `url` is its `.well-known/lnurlp` endpoint. */
  | { kind: 'address'; address: string; url: string };

/**
 * Bech32 data charset. `1`, `b`, `i` and `o` are deliberately excluded from the
 * alphabet so they can't be confused for other characters — which also makes
 * `1` usable as the separator between the human-readable part and the data.
 */
const BECH32_BODY = '[02-9ac-hj-np-z]';
/**
 * Network prefixes, LONGEST FIRST. `bcrt` (regtest) has to be tried before `bc`
 * or the alternation matches `bc` and then chokes on the leftover `rt`.
 */
const LN_PREFIX = '(?:bcrt|bc|tb|sb)';
/** Optional amount, then the mandatory `1` separator, then the data part. */
const INVOICE_RE = new RegExp(`^ln${LN_PREFIX}(?:\\d+[munp]?)?1${BECH32_BODY}{20,}$`, 'i');
const LNURL_RE = new RegExp(`^lnurl1${BECH32_BODY}{6,}$`, 'i');

/**
 * Amount encoded in a BOLT-11 invoice's human-readable part.
 *
 * The HRP is `ln` + network + an optional amount, then the `1` separator. The
 * amount is a decimal followed by a multiplier: m(illi) 10⁻³, u(micro) 10⁻⁶,
 * n(ano) 10⁻⁹, p(ico) 10⁻¹² of a bitcoin; no multiplier means whole bitcoin.
 *
 * The separator is why the amount can't just be read as "the digits after the
 * prefix": in `lnbc1p…` that `1` is the separator and the invoice has NO amount,
 * while in `lnbc21p…` the amount is `2` and the `1` that follows is again the
 * separator. Anchoring on the separator is what tells those apart.
 *
 * An absent amount means an open invoice, where the payer chooses — returned as
 * null, NOT as 0, so a caller can distinguish "pay what you like" from "pay
 * nothing".
 */
export function invoiceAmountSats(invoice: string): number | null {
  const m = new RegExp(`^ln${LN_PREFIX}(\\d+)([munp])?1`, 'i').exec(invoice.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const SATS_PER_BTC = 100_000_000;
  switch (m[2]?.toLowerCase()) {
    case 'm': return Math.round(value * SATS_PER_BTC / 1e3);
    case 'u': return Math.round(value * SATS_PER_BTC / 1e6);
    case 'n': return Math.round(value * SATS_PER_BTC / 1e9);
    // Pico-bitcoin is a tenth of a millisat; BOLT-11 requires the last digit to
    // be 0, and anything below one sat rounds to zero here by design.
    case 'p': return Math.round(value * SATS_PER_BTC / 1e12);
    default: return Math.round(value * SATS_PER_BTC);
  }
}

/**
 * Sats amount of a NIP-57 zap receipt (kind 9735), or null when it can't be
 * determined.
 *
 * Prefers the millisat `amount` tag, then the amount inside the embedded
 * zap-request (`description`), then the amount encoded in the receipt's own
 * BOLT-11 invoice via the shared parser. This is the single source of truth for
 * every zap total in the app: the ad-hoc regexes it replaces disagreed by up to
 * a factor of 100 million (one dropped the ×1e8 for a whole-BTC invoice, another
 * had the pico multiplier 10× off), and one path floored `NaN` from a malformed
 * `amount` tag straight into a note's zap total. A bad amount yields null here,
 * never NaN.
 *
 * NOTE: this does not by itself prove the receipt is genuine — full NIP-57
 * Appendix-F validation would also check the receipt is signed by the
 * recipient's advertised LNURL `nostrPubkey`, which needs that server's config.
 * It does mean a forged `amount` tag can't inflate a total past what the invoice
 * actually encodes.
 */
export function getZapReceiptAmountSats(event: NostrEvent): number | null {
  if (event.kind !== 9735) return null;

  const amountTag = event.tags.find((t) => t[0] === 'amount')?.[1];
  if (amountTag) {
    const msats = parseInt(amountTag, 10);
    if (Number.isFinite(msats) && msats > 0) return Math.floor(msats / 1000);
  }

  const descTag = event.tags.find((t) => t[0] === 'description')?.[1];
  if (descTag) {
    try {
      const zapRequest = JSON.parse(descTag) as { tags?: string[][] };
      const reqAmount = zapRequest.tags?.find((t) => t[0] === 'amount')?.[1];
      if (reqAmount) {
        const msats = parseInt(reqAmount, 10);
        if (Number.isFinite(msats) && msats > 0) return Math.floor(msats / 1000);
      }
    } catch {
      /* malformed description JSON — fall through to the invoice */
    }
  }

  const bolt11 = event.tags.find((t) => t[0] === 'bolt11')?.[1];
  if (bolt11) return invoiceAmountSats(bolt11);
  return null;
}

/**
 * Strip the wrappers a QR code may put around the payload.
 *
 * Handles `lightning:<payload>`, `LIGHTNING://<payload>`, and the BIP-21 form
 * `bitcoin:<addr>?lightning=<payload>` that many wallets encode. Returns the
 * bare payload, or '' when there's nothing usable.
 */
function unwrap(raw: string): string {
  let s = raw.trim();
  if (!s) return '';

  // BIP-21: the on-chain address is not something this app can pay, but the
  // lightning parameter alongside it is.
  const bip21 = /^bitcoin:[^?]*\?(.*)$/i.exec(s);
  if (bip21) {
    const params = new URLSearchParams(bip21[1]);
    // Param names are case-insensitive in practice.
    for (const [key, value] of params) {
      if (key.toLowerCase() === 'lightning' && value.trim()) return value.trim();
    }
    return '';
  }

  s = s.replace(/^lightning:(\/\/)?/i, '').trim();
  // A trailing query string ("?amount=…") isn't part of the payload.
  const q = s.indexOf('?');
  if (q > 0) s = s.slice(0, q);
  return s.trim();
}

/**
 * Parse a scanned or pasted string into something payable.
 *
 * Returns null when the input isn't a Lightning target at all, or when it names
 * a host we refuse to contact (IP literals, private ranges, plain http) — the
 * same SSRF rules the profile-derived zap path applies, because a QR code is no
 * more trustworthy than a stranger's kind-0.
 */
export function parseLightningTarget(raw: string | null | undefined): LightningTarget | null {
  if (typeof raw !== 'string') return null;
  // Control characters never occur in a legitimate payload, and can smuggle a
  // second line past a lenient parser.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  const payload = unwrap(raw);
  if (!payload || payload.length > 4096) return null;

  if (INVOICE_RE.test(payload)) {
    const invoice = payload.toLowerCase();
    return { kind: 'invoice', invoice, amountSats: invoiceAmountSats(invoice) };
  }

  if (LNURL_RE.test(payload)) {
    const url = lud06ToLnurlPayUrl(payload);
    if (!url) return null;
    return { kind: 'lnurl', lnurl: payload.toLowerCase(), url };
  }

  if (payload.includes('@')) {
    const url = lud16ToLnurlPayUrl(payload);
    if (!url) return null;
    return { kind: 'address', address: payload.toLowerCase(), url };
  }

  return null;
}

/**
 * Wrap a BOLT-11 invoice as a `lightning:` URI — what a QR code carries and
 * what a tap hands to an installed wallet app.
 *
 * Returns null unless the input really is an invoice, so this doubles as the
 * guard on every sink that opens one: the platform link helpers refuse anything
 * that isn't http(s), and a `lightning:` URI has to earn its exception here
 * rather than by bypassing them.
 *
 * `forQr` uppercases the whole URI. Bech32 and URI schemes are both case-
 * insensitive, and uppercase lets a QR encoder use its compact alphanumeric
 * mode — the difference between a dense version-13 code and a version-9 one
 * that a phone camera can actually read off a laptop screen.
 */
export function toLightningUri(invoice: string | null | undefined, forQr = false): string | null {
  const parsed = parseLightningTarget(invoice);
  if (parsed?.kind !== 'invoice') return null;
  const uri = `lightning:${parsed.invoice}`;
  return forQr ? uri.toUpperCase() : uri;
}

/** Short, human-readable label for a parsed target — for confirmation UI. */
export function describeLightningTarget(target: LightningTarget): string {
  switch (target.kind) {
    case 'address': return target.address;
    case 'lnurl': {
      try {
        return new URL(target.url).hostname;
      } catch {
        return 'LNURL';
      }
    }
    case 'invoice':
      return target.amountSats === null
        ? 'Invoice (amount not set)'
        : `Invoice for ${target.amountSats.toLocaleString()} sats`;
  }
}
