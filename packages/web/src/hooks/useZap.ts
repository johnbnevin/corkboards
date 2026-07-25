import { useState, useCallback } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAuthor } from '@/hooks/useAuthor';
import { useNwc } from '@/hooks/useNwc';
import { debugLog } from '@/lib/debug';
import { ZAP_RELAYS } from '@/lib/relayConstants';
import { resolveZapEndpoint } from '@core/zap';
import { fetchLnurlPayInfo, checkSendableRange, buildInvoiceUrl, requestInvoice } from '@core/lnurlPay';

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
      const amountMsats = amountSats * 1000;

      // 1. Fetch + validate the LNURL pay info (endpoint resolved from lud16 or
      //    lud06). The fetch, the JSON handling and the SSRF re-check of the
      //    server's own callback all live in @core/lnurlPay so the scan-a-QR
      //    flow can't end up with weaker guards than this one.
      const info = await fetchLnurlPayInfo(zapEndpoint);
      const rangeError = checkSendableRange(info, amountMsats);
      if (rangeError) throw new Error(rangeError);

      debugLog('[zap] LNURL pay info: allowsNostr=%s', info.allowsNostr);

      // 2. Build the callback URL. A NIP-57 zap request is attached only when
      //    the server can actually produce a zap receipt; otherwise this
      //    degrades to a plain LNURL payment with the comment inline.
      let extraParams: Record<string, string> | undefined;
      if (info.allowsNostr && info.nostrPubkey) {
        const zapRequest = await user.signer.signEvent({
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
        extraParams = { nostr: JSON.stringify(zapRequest) };
        debugLog('[zap] Signed zap request, fetching invoice...');
      }
      // The comment rides in the signed zap request when there is one; passing
      // it as well would duplicate it on servers that honour both.
      const invoiceUrl = buildInvoiceUrl(info, amountMsats, {
        comment: extraParams ? undefined : comment,
        extraParams,
      });

      // 3. Request the invoice, then pay it via NWC.
      const bolt11 = await requestInvoice(invoiceUrl);
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
  }, [note, user, zapEndpoint, isConnected, payInvoice]);

  return { zap, isZapping, error, lud16, canZap, isConnected };
}
