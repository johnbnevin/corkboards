/**
 * lnurlPay — turn an LNURL-pay endpoint into a payable BOLT-11 invoice.
 *
 * Split out of the note-zap hook so the scan-a-QR flow can reuse exactly the
 * same request sequence and, more importantly, exactly the same guards. Every
 * value here comes from a server the user did not choose — for a scanned code,
 * from a URL printed on a sticker — so each hop is validated rather than
 * trusted: https-only, no private/metadata hosts, min/max respected, and the
 * server's own `callback` re-checked before we follow it.
 *
 * NIP-57 zap requests are deliberately NOT handled here. A zap request is bound
 * to a specific note and author; a scanned invoice has neither. Callers that
 * want a zap receipt (the note-zap path) build and attach their own.
 */

import { isSafeZapUrl } from './zap';

export interface LnurlPayInfo {
  /** The callback URL to request an invoice from. Already SSRF-checked. */
  callback: string;
  /** Server-declared limits, in millisats. */
  minSendable: number | null;
  maxSendable: number | null;
  /** Max comment length the server accepts; 0 when comments aren't supported. */
  commentAllowed: number;
  /** True when the server can produce NIP-57 zap receipts. */
  allowsNostr: boolean;
  nostrPubkey: string | null;
}

const REQUEST_TIMEOUT_MS = 15_000;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Fetch and validate an LNURL-pay endpoint's parameters. Throws on any problem. */
export async function fetchLnurlPayInfo(endpoint: string): Promise<LnurlPayInfo> {
  if (!isSafeZapUrl(endpoint)) throw new Error('Refusing to contact that lightning address');

  const response = await fetch(endpoint, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Lightning server returned ${response.status}`);

  // Read as text first: a server that answers with HTML shouldn't surface as a
  // raw JSON parse error.
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Lightning server returned invalid JSON');
  }
  if (data.status === 'ERROR') {
    throw new Error(typeof data.reason === 'string' ? data.reason : 'Lightning server returned an error');
  }

  const callback = typeof data.callback === 'string' ? data.callback : '';
  if (!callback) throw new Error('Lightning server sent no callback — this address may not accept payments');
  // The callback is attacker-controlled JSON from a server we may have reached
  // via a scanned code. Re-check it before following it.
  if (!isSafeZapUrl(callback)) throw new Error('Lightning server returned an unsafe callback URL');

  return {
    callback,
    minSendable: asFiniteNumber(data.minSendable),
    maxSendable: asFiniteNumber(data.maxSendable),
    commentAllowed: asFiniteNumber(data.commentAllowed) ?? 0,
    allowsNostr: data.allowsNostr === true,
    nostrPubkey: typeof data.nostrPubkey === 'string' ? data.nostrPubkey : null,
  };
}

/** Human-readable violation of the server's limits, or null when the amount fits. */
export function checkSendableRange(info: LnurlPayInfo, amountMsats: number): string | null {
  if (info.minSendable !== null && amountMsats < info.minSendable) {
    return `Minimum is ${Math.ceil(info.minSendable / 1000).toLocaleString()} sats`;
  }
  if (info.maxSendable !== null && amountMsats > info.maxSendable) {
    return `Maximum is ${Math.floor(info.maxSendable / 1000).toLocaleString()} sats`;
  }
  return null;
}

/**
 * Build the callback URL for an invoice request.
 *
 * `extraParams` carries anything the caller wants appended — the note-zap path
 * uses it for the signed NIP-57 `nostr` parameter.
 */
export function buildInvoiceUrl(
  info: LnurlPayInfo,
  amountMsats: number,
  opts?: { comment?: string; extraParams?: Record<string, string> },
): string {
  const separator = info.callback.includes('?') ? '&' : '?';
  let url = `${info.callback}${separator}amount=${amountMsats}`;
  const comment = opts?.comment?.trim();
  if (comment && info.commentAllowed > 0) {
    url += `&comment=${encodeURIComponent(comment.slice(0, info.commentAllowed))}`;
  }
  for (const [key, value] of Object.entries(opts?.extraParams ?? {})) {
    url += `&${key}=${encodeURIComponent(value)}`;
  }
  return url;
}

/** Request the invoice itself. Returns the BOLT-11 string. Throws on any problem. */
export async function requestInvoice(invoiceUrl: string): Promise<string> {
  // Fresh timeout — the caller may have spent time signing between steps.
  const response = await fetch(invoiceUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Invoice request failed (${response.status})`);

  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Lightning server returned invalid JSON');
  }
  if (data.status === 'ERROR') {
    throw new Error(typeof data.reason === 'string' ? data.reason : 'Lightning server returned an error');
  }
  const bolt11 = typeof data.pr === 'string' ? data.pr.trim() : '';
  if (!bolt11) throw new Error('No invoice returned');
  return bolt11;
}

/** Full LNURL-pay round trip for a plain (non-NIP-57) payment. */
export async function resolveLnurlInvoice(
  endpoint: string,
  amountSats: number,
  comment?: string,
): Promise<string> {
  const amountMsats = amountSats * 1000;
  const info = await fetchLnurlPayInfo(endpoint);
  const rangeError = checkSendableRange(info, amountMsats);
  if (rangeError) throw new Error(rangeError);
  return requestInvoice(buildInvoiceUrl(info, amountMsats, { comment }));
}

/**
 * Full round trip for zapping a note: resolve the endpoint, attach a NIP-57 zap
 * request when the server can honour one, and return the BOLT-11 invoice.
 *
 * Stops at the invoice rather than paying it. Who pays is the caller's business
 * — the connected NWC wallet, or the user's phone scanning a QR code — and both
 * must get the *same* invoice, or a zap paid externally would silently lose its
 * receipt and never show up as a zap on the note. That's why this is one shared
 * function instead of a second, parallel invoice builder for the QR path.
 *
 * @param signZapRequest - Serializes a signed kind-9734 for the `nostr` param.
 *   Omitted (logged out) or returning null degrades to a plain LNURL payment:
 *   the sats still arrive, there's just no zap receipt to publish.
 */
export async function createZapInvoice(
  endpoint: string,
  amountSats: number,
  opts?: {
    comment?: string;
    signZapRequest?: (amountMsats: number) => Promise<string | null>;
  },
): Promise<string> {
  const amountMsats = amountSats * 1000;

  const info = await fetchLnurlPayInfo(endpoint);
  const rangeError = checkSendableRange(info, amountMsats);
  if (rangeError) throw new Error(rangeError);

  let extraParams: Record<string, string> | undefined;
  if (info.allowsNostr && info.nostrPubkey && opts?.signZapRequest) {
    const serialized = await opts.signZapRequest(amountMsats);
    if (serialized) extraParams = { nostr: serialized };
  }

  // The comment rides inside the signed zap request when there is one; passing
  // it again would duplicate it on servers that honour both.
  return requestInvoice(buildInvoiceUrl(info, amountMsats, {
    comment: extraParams ? undefined : opts?.comment,
    extraParams,
  }));
}
