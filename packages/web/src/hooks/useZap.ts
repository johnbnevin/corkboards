import { useState, useCallback } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAuthor } from '@/hooks/useAuthor';
import { useNwc } from '@/hooks/useNwc';
import { debugLog } from '@/lib/debug';
import { ZAP_RELAYS } from '@/lib/relayConstants';
import { resolveZapEndpoint } from '@core/zap';
import { createZapInvoice } from '@core/lnurlPay';
import { getUserRelays } from '@/components/NostrProvider';
import { isSecureRelay } from '@core/nostrUtils';

/** Cap the NIP-57 `relays` tag — some LNURL servers reject very long tags. */
const MAX_ZAP_RECEIPT_RELAYS = 8;

export function useZap(note: NostrEvent | null) {
  const { user } = useCurrentUser();
  const { data: authorData } = useAuthor(note?.pubkey);
  const { payInvoice, isConnected } = useNwc();
  const [isZapping, setIsZapping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lud16 = authorData?.metadata?.lud16;
  // Resolve the LNURL-pay endpoint from lud16 OR lud06 (bech32 LNURL). Some
  // users only set lud06, which the old lud16-only check treated as "no address".
  const zapEndpoint = resolveZapEndpoint(authorData?.metadata);
  const canZap = !!zapEndpoint;

  /**
   * Produce the invoice for this note without paying it.
   *
   * Deliberately NOT gated on a connected wallet: this is what the external-
   * wallet path shows as a QR code. The fetch, the JSON handling, the SSRF
   * re-check of the server's own callback and the NIP-57 attachment all live in
   * @core/lnurlPay, so the invoice a stranger's phone pays is byte-for-byte the
   * one NWC would have paid — same zap request, same receipt.
   */
  const createInvoice = useCallback(async (amountSats: number, comment?: string): Promise<string> => {
    if (!note || !zapEndpoint) throw new Error('Missing note or lightning address');

    return createZapInvoice(zapEndpoint, amountSats, {
      comment,
      // Logged out, the zap still pays — it just can't be signed, so it
      // arrives as a plain LNURL payment with no receipt.
      signZapRequest: user
        ? async (amountMsats) => {
            // NIP-57 `relays` tells the LNURL server where to PUBLISH the
            // kind-9735 receipt. Hardcoding ZAP_RELAYS meant the receipt landed
            // only on our defaults: if the user reads from anywhere else, their
            // own zap never appeared in their notifications, and neither the
            // sender nor the recipient could find the proof of payment on the
            // relays they actually use. Their read relays go FIRST (the ones
            // that matter for them seeing it), with our defaults kept as a
            // safety net so a user with no NIP-65 list still gets a receipt.
            const userReadRelays = getUserRelays().read;
            const receiptRelays = [...new Set([...userReadRelays, ...ZAP_RELAYS])]
              .filter(isSecureRelay)
              .slice(0, MAX_ZAP_RECEIPT_RELAYS);
            const zapRequest = await user.signer.signEvent({
              kind: 9734,
              content: comment || '',
              tags: [
                ['p', note.pubkey],
                ['e', note.id],
                ['amount', amountMsats.toString()],
                ['relays', ...(receiptRelays.length > 0 ? receiptRelays : ZAP_RELAYS)],
              ],
              created_at: Math.floor(Date.now() / 1000),
            });
            debugLog('[zap] Signed zap request, fetching invoice...');
            return JSON.stringify(zapRequest);
          }
        : undefined,
    });
  }, [note, user, zapEndpoint]);

  const zap = useCallback(async (amountSats: number, comment?: string) => {
    if (!note || !user || !zapEndpoint) {
      setError('Missing note, user, or lightning address');
      return;
    }
    if (!isConnected) {
      setError('No wallet connected');
      return;
    }

    setIsZapping(true);
    setError(null);

    try {
      const bolt11 = await createInvoice(amountSats, comment);
      debugLog('[zap] Got invoice, paying via NWC...');
      await payInvoice(bolt11);
      debugLog('[zap] Payment complete!');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Zap failed';
      setError(message);
      throw err;
    } finally {
      setIsZapping(false);
    }
  }, [note, user, zapEndpoint, isConnected, payInvoice, createInvoice]);

  return { zap, createInvoice, isZapping, error, lud16, canZap, isConnected };
}
