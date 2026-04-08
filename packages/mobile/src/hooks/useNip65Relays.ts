import { useCallback } from 'react';
import { useNostr, updateRelayCache, getRelayCache } from '../lib/NostrProvider';

function isValidRelayUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 256) return false;
  try { return new URL(url).protocol === 'wss:'; } catch { return false; }
}

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
      const [event] = await nostr.query(
        [{ kinds: [10002], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      if (!event) return [];

      const relays = event.tags
        .filter(([name, url]) => name === 'r' && isValidRelayUrl(url))
        .map(([, url]) => url as string)
        .slice(0, MAX_RELAYS_PER_USER);

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
        const relays = event.tags
          .filter(([name, url]) => name === 'r' && isValidRelayUrl(url))
          .map(([, url]) => url as string)
          .slice(0, MAX_RELAYS_PER_USER);
        if (relays.length > 0) updateRelayCache(event.pubkey, relays);
      }
    } catch {
      // best effort
    }
  }, [nostr]);

  return { fetchRelaysForPubkey, fetchRelaysForMultiple };
}
