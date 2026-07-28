/**
 * useNostrDismissedSync — saves/loads dismissed + collapsed (saved-for-later)
 * notes as NIP-78 kind 30078 encrypted Nostr events.
 *
 * Port of packages/web/src/hooks/useNostrDismissedSync.ts for mobile.
 * Uses mobile's AuthContext and NostrProvider instead of web equivalents.
 *
 * ## Why 30078 and not 35572
 *
 * Same reasoning as useNostrCustomFeedsSync: 35572 was an unregistered,
 * app-private kind for data NIP-78 (kind 30078, "arbitrary custom app data")
 * already describes. The d-tag (`corkboard:dismissed`) is unchanged, so the
 * data keeps its identity.
 *
 * READS still accept the legacy kind 35572 for one release (newest-wins across
 * both). Web mirrors this exactly — same kind, same d-tag. Do not diverge.
 */
import { useCallback, useRef } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, createRelay } from '../lib/NostrProvider';
import { encryptForSelf, decryptFromSelf } from '../lib/nostrEncrypt';
import { useAuth } from '../lib/AuthContext';

/** NIP-78 app-specific data. All new writes go here. */
const KIND = 30078;
/** Pre-NIP-78 proprietary kind. READ-ONLY, for one release, so upgrades don't lose data. */
const LEGACY_KIND = 35572;
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
        const relay = createRelay(url, { backoff: false });
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
      const relay = createRelay(url, { backoff: false });
      try {
        // Dual-read across the NIP-78 kind and the legacy one, newest wins —
        // a user who last saved on an older build only has data under 35572,
        // and reading just 30078 would look like "nothing was ever dismissed"
        // and then overwrite the real list on the next save.
        const events = await relay.query(
          [{ kinds: [KIND, LEGACY_KIND], authors: [pubkey], '#d': [D_TAG], limit: 2 }],
          { signal: AbortSignal.timeout(5000) }
        );
        for (const event of events) {
          if (event.pubkey !== pubkey) continue;
          if (!best || event.created_at > best.created_at) best = event;
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
