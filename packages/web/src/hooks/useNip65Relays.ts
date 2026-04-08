import { useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import { updateRelayCache, getRelayCache } from '@/components/NostrProvider';

/** Validate a relay URL: must be a well-formed wss:// URL ≤256 chars. */
function isValidRelayUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 256) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'wss:';
  } catch {
    return false;
  }
}

const MAX_RELAYS_PER_USER = 20;

/**
 * Hook to fetch and cache NIP-65 relays for users
 */
export function useNip65Relays() {
  const { nostr } = useNostr();

  const fetchRelaysForPubkey = useCallback(async (pubkey: string, externalSignal?: AbortSignal): Promise<string[]> => {
    // Check cache first
    const cached = getRelayCache(pubkey);
    if (cached && cached.length > 0) {
      return cached;
    }

    try {
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const events = await nostr.query(
        [{ kinds: [10002], authors: [pubkey], limit: 1 }],
        { signal }
      );

      if (events.length === 0) {
        return [];
      }

      const event = events[0];
      const relays = event.tags
        .filter(([name, url]) => name === 'r' && isValidRelayUrl(url))
        .map(([, url]) => url as string)
        .slice(0, MAX_RELAYS_PER_USER);

      // Update the global cache
      if (relays.length > 0) {
        updateRelayCache(pubkey, relays);
      }

      return relays;
    } catch {
      return [];
    }
  }, [nostr]);

  const fetchRelaysForMultiple = useCallback(async (pubkeys: string[]) => {
    // Filter out already cached pubkeys to avoid unnecessary fetches
    const pubkeysToFetch = pubkeys.filter(pk => {
      const cached = getRelayCache(pk);
      return !cached || cached.length === 0;
    });

    if (pubkeysToFetch.length === 0) {
      return [];
    }

    try {
      // Single batched query for all uncached pubkeys instead of N parallel queries
      const signal = AbortSignal.timeout(5000);
      const events = await nostr.query(
        [{ kinds: [10002], authors: pubkeysToFetch, limit: pubkeysToFetch.length }],
        { signal }
      );

      // Fan out results into the relay cache per pubkey
      for (const event of events) {
        const relays = event.tags
          .filter(([name, url]) => name === 'r' && isValidRelayUrl(url))
          .map(([_, url]) => url as string)
          .slice(0, MAX_RELAYS_PER_USER);
        if (relays.length > 0) {
          updateRelayCache(event.pubkey, relays);
        }
      }
    } catch {
      // Best-effort; callers tolerate missing relay info
    }

    return [];
  }, [nostr]);

  return {
    fetchRelaysForPubkey,
    fetchRelaysForMultiple,
  };
}
