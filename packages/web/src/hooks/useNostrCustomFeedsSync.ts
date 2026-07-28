/**
 * useNostrCustomFeedsSync — saves/loads custom corkboards as NIP-78 kind 30078
 * encrypted Nostr events (addressable, replaceable via d-tag).
 *
 * Each user gets one event: kind 30078, d-tag "corkboard:feeds".
 * Content is AES-256-GCM encrypted JSON of the CustomFeed[] array.
 * The AES key is NIP-44 wrapped to the user's own pubkey.
 *
 * ## Why 30078 and not 35571
 *
 * This used to write kind 35571 — a number nobody registered, nobody else
 * reads, and no NIP defines. NIP-78 (kind 30078, "arbitrary custom app data")
 * already covers exactly this case: addressable, replaceable per `d` tag,
 * namespaced by the app. Minting a private kind where a standard one fits is
 * lock-in wearing protocol clothes: a relay operator can't reason about it, no
 * other client can read or migrate the data, and the user's exit stops being
 * free. The d-tag is unchanged (`corkboard:feeds`), so the data keeps its
 * identity; only the kind moves to the one that was always right.
 *
 * READS still accept the legacy kind 35571 for one release (newest-wins across
 * both), so nobody's corkboards vanish on upgrade. Mobile mirrors this exactly —
 * same kind, same d-tag. Do not diverge.
 */
import { useCallback, useRef } from 'react';
import type { NostrEvent, NPool } from '@nostrify/nostrify';
import type { NUser } from '@nostrify/react/login';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, createRelayFresh } from '@/components/NostrProvider';
import { encryptForSelf, decryptFromSelf } from '@/lib/nostrEncrypt';

/** NIP-78 app-specific data. All new writes go here. */
const KIND = 30078;
/** Pre-NIP-78 proprietary kind. READ-ONLY, for one release, so upgrades don't lose data. */
const LEGACY_KIND = 35571;
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
        // Fresh (uncached) instance — we close it in the finally, and closing
        // a shared cached relay would poison it for every other caller.
        const relay = createRelayFresh(url, { backoff: false });
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
      const relay = createRelayFresh(url, { backoff: false });
      try {
        // Dual-read: the NIP-78 event AND the legacy proprietary one, newest
        // wins. A user who last saved on an older build has their data only
        // under 35571; reading just 30078 would show them an empty corkboard
        // list and then overwrite the real one on the next save.
        const events = await relay.query(
          [{ kinds: [KIND, LEGACY_KIND], authors: [user.pubkey], '#d': [D_TAG], limit: 2 }],
          { signal: AbortSignal.timeout(5000) }
        );
        for (const event of events) {
          if (event.pubkey !== user.pubkey) continue;
          if (!best || event.created_at > best.created_at) best = event;
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
