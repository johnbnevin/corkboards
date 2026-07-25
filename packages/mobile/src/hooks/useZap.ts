/**
 * useZap — pay a zap to a note via LNURL + NWC.
 * Port of packages/web/src/hooks/useZap.ts.
 */
import { useState, useCallback } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuth } from '../lib/AuthContext';
import { useAuthor } from './useAuthor';
import { useNwc } from './useNwc';
import { ZAP_RELAYS } from '../lib/NostrProvider';
import { resolveZapEndpoint } from '@core/zap';
import { createZapInvoice } from '@core/lnurlPay';

export function useZap(note: NostrEvent | null) {
  const { signer } = useAuth();
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
   * wallet path shows as a QR code. Sharing @core/createZapInvoice with the NWC
   * path means the invoice an external wallet pays carries the same signed zap
   * request, and so earns the same receipt.
   */
  const createInvoice = useCallback(async (amountSats: number, comment?: string): Promise<string> => {
    if (!note || !zapEndpoint) throw new Error('Missing note or lightning address');

    return createZapInvoice(zapEndpoint, amountSats, {
      comment,
      // Signed out, the zap still pays — it just arrives as a plain LNURL
      // payment with no receipt.
      signZapRequest: signer
        ? async (amountMsats) => {
            const zapRequest = await signer.signEvent({
              kind: 9734,
              content: comment || '',
              tags: [
                ['p', note.pubkey],
                ['e', note.id],
                ['amount', amountMsats.toString()],
                ['relays', ...ZAP_RELAYS],
              ],
              created_at: Math.floor(Date.now() / 1000),
            });
            return JSON.stringify(zapRequest);
          }
        : undefined,
    });
  }, [note, signer, zapEndpoint]);

  const zap = useCallback(async (amountSats: number, comment?: string) => {
    if (!note || !signer || !zapEndpoint) {
      setError('Missing note, user, or lightning address');
      return;
    }
    if (!isConnected) {
      setError('No wallet connected. Add a NWC URI in Settings.');
      return;
    }

    setIsZapping(true);
    setError(null);

    try {
      const bolt11 = await createInvoice(amountSats, comment);
      await payInvoice(bolt11);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Zap failed';
      setError(message);
      throw err;
    } finally {
      setIsZapping(false);
    }
  }, [note, signer, zapEndpoint, isConnected, payInvoice, createInvoice]);

  const clearError = useCallback(() => setError(null), []);

  return { zap, createInvoice, isZapping, error, clearError, lud16, canZap, isConnected };
}
