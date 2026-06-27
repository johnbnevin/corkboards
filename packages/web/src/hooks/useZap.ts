import { useState, useCallback } from 'react';
import { type NostrEvent } from '@nostrify/nostrify';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAuthor } from '@/hooks/useAuthor';
import { useNwc } from '@/hooks/useNwc';
import { debugLog } from '@/lib/debug';
import { ZAP_RELAYS } from '@/lib/relayConstants';
import { resolveZapEndpoint, isSafeZapUrl } from '@core/zap';

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

      // 1. Fetch the LNURL pay info (endpoint resolved from lud16 or lud06)
      const lnurlResponse = await fetch(zapEndpoint, { signal: AbortSignal.timeout(15000) });
      if (!lnurlResponse.ok) throw new Error(`LNURL server returned ${lnurlResponse.status}`);
      const lnurlText = await lnurlResponse.text();
      let lnurlData: Record<string, unknown>;
      try {
        lnurlData = JSON.parse(lnurlText);
      } catch {
        throw new Error('LNURL server returned invalid JSON');
      }
      if (lnurlData.status === 'ERROR') {
        throw new Error((lnurlData.reason as string) || 'LNURL server returned an error');
      }
      if (!lnurlData.callback) throw new Error('LNURL server missing callback — this lightning address may not support payments');
      if (lnurlData.minSendable && amountMsats < (lnurlData.minSendable as number)) {
        throw new Error(`Minimum sendable is ${Math.ceil((lnurlData.minSendable as number) / 1000)} sats`);
      }
      if (lnurlData.maxSendable && amountMsats > (lnurlData.maxSendable as number)) {
        throw new Error(`Maximum sendable is ${Math.floor((lnurlData.maxSendable as number) / 1000)} sats`);
      }

      // 2. Build callback URL — include zap request only if server supports NIP-57
      const callback = lnurlData.callback as string;
      // SSRF guard: the callback comes from the (untrusted) LNURL server's JSON.
      // Never fetch it — or POST a signed zap request to it — unless it's https
      // and not a private/metadata host.
      if (!isSafeZapUrl(callback)) {
        throw new Error('LNURL server returned an unsafe callback URL');
      }
      const separator = callback.includes('?') ? '&' : '?';
      let invoiceUrl = `${callback}${separator}amount=${amountMsats}`;

      debugLog('[zap] LNURL pay info: allowsNostr=%s', lnurlData.allowsNostr);

      if (lnurlData.allowsNostr && lnurlData.nostrPubkey) {
        // Server supports NIP-57 zaps — sign and attach a zap request
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
        invoiceUrl += `&nostr=${encodeURIComponent(JSON.stringify(zapRequest))}`;
        debugLog('[zap] Signed zap request, fetching invoice...');
      } else if (comment) {
        // Plain LNURL payment — attach comment if server allows it
        const commentAllowed = (lnurlData.commentAllowed as number) || 0;
        if (commentAllowed > 0) {
          invoiceUrl += `&comment=${encodeURIComponent(comment.slice(0, commentAllowed))}`;
        }
      }

      // 3. Request invoice from LNURL callback (fresh timeout — user may have spent time signing)
      const invoiceResponse = await fetch(invoiceUrl, { signal: AbortSignal.timeout(15000) });
      if (!invoiceResponse.ok) throw new Error(`Invoice request failed (${invoiceResponse.status})`);
      const invoiceData = await invoiceResponse.json();

      if (invoiceData.status === 'ERROR') {
        throw new Error(invoiceData.reason || 'LNURL service returned an error');
      }

      const bolt11 = invoiceData.pr;
      if (!bolt11) throw new Error('No invoice returned from LNURL service');

      debugLog('[zap] Got invoice, paying via NWC...');

      // 4. Pay the invoice via NWC
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
