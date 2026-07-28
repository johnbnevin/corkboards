import { useCallback } from 'react';
import { useNostr, updateRelayCache, getRelayCache } from '../lib/NostrProvider';
import { PROFILE_INDEXER_RELAYS } from '@core/relayConstants';
import { nip65OutboxRelays } from '../lib/nip65';

const MAX_RELAYS_PER_USER = 20;

/**
 * Fetch and cache NIP-65 relay lists (kind 10002) for users.
 */
export function useNip65Relays() {
  const { nostr } = useNostr();

  const fetchRelaysForPubkey = useCallback(async (pubkey: string): Promise<string[]> => {
    const cached = getRelayCache(pubkey);
    if (cached.length > 0) return cached;

    try {
      const initial = await nostr.query(
        [{ kinds: [10002], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      let event: (typeof initial)[number] | undefined = initial[0];
      // Fall back to the profile indexers (hold kind-10002 for ~everyone) so an
      // author we don't already know still gets a discoverable outbox.
      if (!event) {
        event = await Promise.any(
          PROFILE_INDEXER_RELAYS.map(async (url) => {
            const [ev] = await nostr.relay(url).query(
              [{ kinds: [10002], authors: [pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(4000) },
            );
            if (!ev) throw new Error('none');
            return ev;
          }),
        ).catch(() => undefined);
      }
      if (!event) return [];

      // Outbox only — a `read`-marked relay is an inbox for mentions and will
      // never hold this author's own notes (NIP-65).
      const relays = nip65OutboxRelays(event.tags, MAX_RELAYS_PER_USER);

      if (relays.length > 0) updateRelayCache(pubkey, relays);
      return relays;
    } catch {
      return [];
    }
  }, [nostr]);

  const fetchRelaysForMultiple = useCallback(async (pubkeys: string[]) => {
    const toFetch = pubkeys.filter(pk => getRelayCache(pk).length === 0);
    if (toFetch.length === 0) return;

    try {
      const events = await nostr.query(
        [{ kinds: [10002], authors: toFetch, limit: toFetch.length }],
        { signal: AbortSignal.timeout(5000) },
      );
      for (const event of events) {
        const relays = nip65OutboxRelays(event.tags, MAX_RELAYS_PER_USER);
        if (relays.length > 0) updateRelayCache(event.pubkey, relays);
      }
    } catch {
      // best effort
    }
  }, [nostr]);

  return { fetchRelaysForPubkey, fetchRelaysForMultiple };
}
