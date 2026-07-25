/**
 * createZapInvoice — the one place a note-zap invoice is built.
 *
 * Both payment paths call it: the connected NWC wallet, and the QR code shown
 * to a wallet this app has no connection to. The reason it's shared is the
 * NIP-57 attachment — an invoice built without the signed zap request still
 * moves the sats but produces no receipt, so the zap would never appear on the
 * note. These cases pin that the external-wallet path can't quietly lose it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createZapInvoice } from '@core/lnurlPay';

const ENDPOINT = 'https://example.com/.well-known/lnurlp/alice';
const CALLBACK = 'https://example.com/lnurl/pay';
const BOLT11 = 'lnbc210n1pqpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';

interface PayInfoOverrides {
  allowsNostr?: boolean;
  nostrPubkey?: string | null;
  commentAllowed?: number;
  minSendable?: number;
  maxSendable?: number;
}

/** Stub the two-hop LNURL round trip; returns the URLs that were fetched. */
function stubLnurl(overrides: PayInfoOverrides = {}) {
  const calls: string[] = [];
  const info = {
    callback: CALLBACK,
    minSendable: overrides.minSendable ?? 1000,
    maxSendable: overrides.maxSendable ?? 100_000_000,
    commentAllowed: overrides.commentAllowed ?? 200,
    allowsNostr: overrides.allowsNostr ?? true,
    nostrPubkey: overrides.nostrPubkey === undefined ? 'a'.repeat(64) : overrides.nostrPubkey,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.startsWith(CALLBACK) ? { pr: BOLT11 } : info;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('createZapInvoice', () => {
  it('attaches the signed zap request when the server can produce receipts', async () => {
    const calls = stubLnurl();
    const signZapRequest = vi.fn(async (msats: number) => JSON.stringify({ kind: 9734, amount: msats }));

    const invoice = await createZapInvoice(ENDPOINT, 21, { comment: 'nice one', signZapRequest });

    expect(invoice).toBe(BOLT11);
    expect(signZapRequest).toHaveBeenCalledWith(21_000);
    const invoiceUrl = calls[1];
    expect(invoiceUrl).toContain('amount=21000');
    expect(invoiceUrl).toContain('nostr=');
    // The comment rides inside the signed request; sending it twice duplicates
    // it on servers that honour both.
    expect(invoiceUrl).not.toContain('comment=');
  });

  it('falls back to a plain payment with an inline comment when signing is unavailable', async () => {
    const calls = stubLnurl();

    await createZapInvoice(ENDPOINT, 21, { comment: 'nice one' });

    expect(calls[1]).not.toContain('nostr=');
    expect(calls[1]).toContain('comment=nice%20one');
  });

  it('skips the zap request when the server does not support nostr', async () => {
    const calls = stubLnurl({ allowsNostr: false });
    const signZapRequest = vi.fn(async () => JSON.stringify({ kind: 9734 }));

    await createZapInvoice(ENDPOINT, 21, { signZapRequest });

    expect(signZapRequest).not.toHaveBeenCalled();
    expect(calls[1]).not.toContain('nostr=');
  });

  it('enforces the server-declared range before asking for an invoice', async () => {
    const calls = stubLnurl({ minSendable: 100_000 });
    await expect(createZapInvoice(ENDPOINT, 21)).rejects.toThrow(/Minimum is 100 sats/);
    // Rejected before the second hop — no invoice was requested.
    expect(calls).toHaveLength(1);
  });

  it('refuses an endpoint that fails the SSRF guard', async () => {
    stubLnurl();
    await expect(createZapInvoice('http://127.0.0.1/lnurlp', 21)).rejects.toThrow(/Refusing to contact/);
  });
});
