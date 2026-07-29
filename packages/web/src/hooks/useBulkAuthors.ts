/**
 * useBulkAuthors
 *
 * Efficiently prefetches profiles for all unique pubkeys in a set of notes.
 * Populates React Query cache BEFORE rendering, eliminating N network requests
 * for N notes (reduces to 1-2 batch queries).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { useCallback, useMemo } from 'react';
import { debugLog } from '@/lib/debug';
import type { NostrEvent } from '@nostrify/nostrify';
import { NSchema as n } from '@nostrify/nostrify';
import { getCachedProfiles, cacheProfile } from '@/lib/cacheStore';
import { fetchProfilesBulk, MAX_BULK_PROFILE_FETCH, type ProfilePool } from '@core/profileBulkFetch';

// Pubkeys currently being fetched by ANY prefetch call. Concurrent calls skip
// these instead of the old whole-call drop (which silently left every author
// of a newly-loaded page unprefetched whenever a previous batch was in flight).
const inFlightPubkeys = new Set<string>();

export function extractPubkeys(notes: NostrEvent[]): string[] {
  const pubkeys = new Set<string>();
  for (const note of notes) {
    pubkeys.add(note.pubkey);
    for (const [tagName, value] of note.tags) {
      if (tagName === 'p' && value && value.length === 64) {
        pubkeys.add(value);
      }
    }
  }
  return Array.from(pubkeys);
}

export function useBulkAuthors() {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const prefetchAuthors = useCallback(async (pubkeys: string[], signal?: AbortSignal) => {
    if (pubkeys.length === 0) return;

    // Skip pubkeys another prefetch call is already fetching, but still process
    // the rest — dropping the whole call left new pages unresolved.
    const uniquePubkeys = [...new Set(pubkeys)]
      .filter(pk => !inFlightPubkeys.has(pk))
      .slice(0, MAX_BULK_PROFILE_FETCH);
    if (uniquePubkeys.length === 0) return;
    for (const pk of uniquePubkeys) inFlightPubkeys.add(pk);

    try {
      const cachedProfiles = await getCachedProfiles(uniquePubkeys, Infinity);

      const cachedPubkeys = new Set(cachedProfiles.keys());
      const uncachedPubkeys = uniquePubkeys.filter(pk => !cachedPubkeys.has(pk));

      for (const [pubkey, cached] of cachedProfiles) {
        if (cached.metadata) {
          queryClient.setQueryData(['author', pubkey], {
            metadata: cached.metadata,
            event: cached.event,
          });
        }
      }

      if (uncachedPubkeys.length === 0) {
        debugLog('[bulkAuthors] All', uniquePubkeys.length, 'profiles found in cache');
        return;
      }

      debugLog('[bulkAuthors] Fetching', uncachedPubkeys.length, 'profiles from network...');

      // Pool + profile indexers per batch, with an indexer retry pass for
      // stragglers (@core/profileBulkFetch). The pool-only version of this left
      // every miss to the 6-concurrent per-card trickle — minutes of gray
      // placeholders after a cold start.
      const events = await fetchProfilesBulk(nostr as unknown as ProfilePool, uncachedPubkeys, { signal });

      let fetched = 0;
      for (const event of events.values()) {
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event.content);
          queryClient.setQueryData(['author', event.pubkey], { metadata, event });
          cacheProfile(event.pubkey, metadata, event).catch(() => {});
          fetched++;
        } catch {
          // Invalid metadata, skip
        }
      }
      debugLog('[bulkAuthors] Fetched', fetched, 'of', uncachedPubkeys.length, 'profiles from network');
    } finally {
      for (const pk of uniquePubkeys) inFlightPubkeys.delete(pk);
    }
  }, [nostr, queryClient]);

  const prefetchFromNotes = useCallback(async (notes: NostrEvent[], signal?: AbortSignal) => {
    const pubkeys = extractPubkeys(notes);
    return prefetchAuthors(pubkeys, signal);
  }, [prefetchAuthors]);

  return {
    prefetchAuthors,
    prefetchFromNotes,
  };
}

export function useNotesPubkeys(notes: NostrEvent[]): string[] {
  return useMemo(() => extractPubkeys(notes), [notes]);
}
