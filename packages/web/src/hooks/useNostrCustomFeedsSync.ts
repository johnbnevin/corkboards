/**
 * useNostrCustomFeedsSync — saves/loads custom corkboards as kind 35571
 * encrypted Nostr events (addressable, replaceable via d-tag).
 *
 * Each user gets one event: kind 35571, d-tag "corkboard:feeds".
 * Content is AES-256-GCM encrypted JSON of the CustomFeed[] array.
 * The AES key is NIP-44 wrapped to the user's own pubkey.
 */
import { useCallback, useRef } from 'react';
import { NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent, NPool } from '@nostrify/nostrify';
import type { NUser } from '@nostrify/react/login';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache } from '@/components/NostrProvider';
import { encryptForSelf, decryptFromSelf } from '@/lib/nostrEncrypt';

const KIND = 35571;
const D_TAG = 'corkboard:feeds';

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

export function useNostrCustomFeedsSync(user: NUser | undefined, _nostr: NPool) {
  const savingRef = useRef(false);

  const save = useCallback(async (feedsJson: string): Promise<boolean> => {
    if (!user || savingRef.current) return false;
    savingRef.current = true;

    try {
      const { content, wrappedKey, signerMethod } = await encryptForSelf(
        feedsJson, user.signer, user.pubkey
      );

      const event = await user.signer.signEvent({
        kind: KIND,
        content,
        tags: [
          ['d', D_TAG],
          ['wrappedKey', wrappedKey],
          ['signerMethod', signerMethod],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });

      const relays = getPublishRelays(user.pubkey);
      let succeeded = 0;
      for (const url of relays) {
        const relay = new NRelay1(url);
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
  }, [user]);

  const load = useCallback(async (): Promise<string | null> => {
    if (!user) return null;

    // Query relays for the latest event
    const relays = getPublishRelays(user.pubkey);
    let best: NostrEvent | null = null;

    for (const url of relays) {
      const relay = new NRelay1(url);
      try {
        const [event] = await relay.query(
          [{ kinds: [KIND], authors: [user.pubkey], '#d': [D_TAG], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );
        if (event && (!best || event.created_at > best.created_at)) {
          best = event;
        }
      } catch { /* continue */ }
      finally { try { relay.close(); } catch { /* */ } }
    }

    if (!best) return null;

    // Decrypt
    const wrappedKey = best.tags.find(t => t[0] === 'wrappedKey')?.[1];
    const signerMethod = (best.tags.find(t => t[0] === 'signerMethod')?.[1] || 'nip44') as 'nip44' | 'nip04';
    if (!wrappedKey) return null;

    try {
      return await decryptFromSelf(best.content, wrappedKey, signerMethod, user.signer, user.pubkey);
    } catch {
      return null;
    }
  }, [user]);

  return { save, load };
}
