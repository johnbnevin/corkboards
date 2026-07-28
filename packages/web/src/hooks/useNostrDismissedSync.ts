/**
 * useNostrDismissedSync — saves/loads dismissed + collapsed (saved-for-later)
 * notes as NIP-78 kind 30078 encrypted Nostr events.
 *
 * Each user gets one event: kind 30078, d-tag "corkboard:dismissed".
 * Content is AES-256-GCM encrypted JSON of { dismissed: string[], collapsed: string[] }.
 * The AES key is NIP-44 wrapped to the user's own pubkey.
 *
 * ## Why 30078 and not 35572
 *
 * Same reasoning as useNostrCustomFeedsSync: 35572 was an unregistered,
 * app-private kind for data NIP-78 (kind 30078, "arbitrary custom app data")
 * already models — addressable, replaceable per `d` tag, namespaced by the app.
 * A kind nobody else reads is lock-in wearing protocol clothes. The d-tag stays
 * `corkboard:dismissed`, so the data keeps its identity.
 *
 * READS still accept the legacy kind 35572 for one release (newest-wins across
 * both), so nobody's dismissed/saved notes vanish on upgrade. Mobile mirrors
 * this exactly — same kind, same d-tag. Do not diverge.
 */
import { useCallback, useRef } from 'react';
import type { NostrEvent, NPool } from '@nostrify/nostrify';
import type { NUser } from '@nostrify/react/login';
import { FALLBACK_RELAYS, getUserRelays, getRelayCache, createRelayFresh } from '@/components/NostrProvider';
import { encryptForSelf, decryptFromSelf } from '@/lib/nostrEncrypt';

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

export function useNostrDismissedSync(user: NUser | undefined, _nostr: NPool) {
  const savingRef = useRef(false);

  const save = useCallback(async (data: DismissedData): Promise<boolean> => {
    if (!user || savingRef.current) return false;
    savingRef.current = true;

    try {
      const plaintext = JSON.stringify(data);
      const { content, wrappedKey, signerMethod } = await encryptForSelf(
        plaintext, user.signer, user.pubkey
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

  const load = useCallback(async (): Promise<DismissedData | null> => {
    if (!user) return null;

    const relays = getPublishRelays(user.pubkey);
    let best: NostrEvent | null = null;

    for (const url of relays) {
      const relay = createRelayFresh(url, { backoff: false });
      try {
        // Dual-read: the NIP-78 event AND the legacy proprietary one, newest
        // wins — otherwise upgrading looks like every dismissed/saved note was
        // forgotten, and the next save writes that emptiness back.
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

    const wrappedKey = best.tags.find(t => t[0] === 'wrappedKey')?.[1];
    const signerMethod = (best.tags.find(t => t[0] === 'signerMethod')?.[1] || 'nip44') as 'nip44' | 'nip04';
    if (!wrappedKey) return null;

    try {
      const json = await decryptFromSelf(best.content, wrappedKey, signerMethod, user.signer, user.pubkey);
      return JSON.parse(json) as DismissedData;
    } catch {
      return null;
    }
  }, [user]);

  return { save, load };
}
