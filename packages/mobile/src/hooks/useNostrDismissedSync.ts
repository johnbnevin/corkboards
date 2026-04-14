/**
 * useNostrDismissedSync — saves/loads dismissed + collapsed (saved-for-later)
 * notes as kind 35572 encrypted Nostr events.
 *
 * Port of packages/web/src/hooks/useNostrDismissedSync.ts for mobile.
 * Uses mobile's AuthContext and NostrProvider instead of web equivalents.
 */
import { useCallback, useRef } from 'react';
import { NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent } from '@nostrify/nostrify';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache } from '../lib/NostrProvider';
import { encryptForSelf, decryptFromSelf } from '../lib/nostrEncrypt';
import { useAuth } from '../lib/AuthContext';

const KIND = 35572;
const D_TAG = 'corkboard:dismissed';

function normalizeRelay(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

function getPublishRelays(pubkey: string): string[] {
  const relays = new Set<string>();
  for (const r of getUserRelays().write) relays.add(normalizeRelay(r));
  for (const r of getRelayCache(pubkey)) relays.add(normalizeRelay(r));
  for (const r of FALLBACK_RELAYS) relays.add(normalizeRelay(r));
  return Array.from(relays);
}

export interface DismissedData {
  dismissed: string[];
  collapsed: string[];
}

export function useNostrDismissedSync() {
  const { pubkey, signer } = useAuth();
  const savingRef = useRef(false);

  const save = useCallback(async (data: DismissedData): Promise<boolean> => {
    if (!pubkey || !signer || savingRef.current) return false;
    savingRef.current = true;

    try {
      const plaintext = JSON.stringify(data);
      const { content, wrappedKey, signerMethod } = await encryptForSelf(
        plaintext, signer, pubkey
      );

      const event = await signer.signEvent({
        kind: KIND,
        content,
        tags: [
          ['d', D_TAG],
          ['wrappedKey', wrappedKey],
          ['signerMethod', signerMethod],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });

      const relays = getPublishRelays(pubkey);
      let succeeded = 0;
      for (const url of relays) {
        const relay = new NRelay1(url, { backoff: false });
        try {
          await relay.event(event, { signal: AbortSignal.timeout(8000) });
          succeeded++;
        } catch { /* continue */ }
        finally { try { relay.close(); } catch { /* */ } }
      }

      return succeeded > 0;
    } finally {
      savingRef.current = false;
    }
  }, [pubkey, signer]);

  const load = useCallback(async (): Promise<DismissedData | null> => {
    if (!pubkey || !signer) return null;

    const relays = getPublishRelays(pubkey);
    let best: NostrEvent | null = null;

    for (const url of relays) {
      const relay = new NRelay1(url, { backoff: false });
      try {
        const [event] = await relay.query(
          [{ kinds: [KIND], authors: [pubkey], '#d': [D_TAG], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );
        if (event && (!best || event.created_at > best.created_at)) {
          best = event;
        }
      } catch { /* continue */ }
      finally { try { relay.close(); } catch { /* */ } }
    }

    if (!best) return null;

    const wrappedKey = best.tags.find(t => t[0] === 'wrappedKey')?.[1];
    const signerMethod = (best.tags.find(t => t[0] === 'signerMethod')?.[1] || 'nip44') as 'nip44' | 'nip04';
    if (!wrappedKey) return null;

    try {
      const json = await decryptFromSelf(best.content, wrappedKey, signerMethod, signer, pubkey);
      return JSON.parse(json) as DismissedData;
    } catch {
      return null;
    }
  }, [pubkey, signer]);

  return { save, load };
}
