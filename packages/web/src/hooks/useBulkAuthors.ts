/**
 * useBulkAuthors
 *
 * Efficiently prefetches profiles for all unique pubkeys in a set of notes.
 * Populates React Query cache BEFORE rendering, eliminating N network requests
 * for N notes (reduces to 1-2 batch queries).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { useCallback, useMemo, useRef } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { NSchema as n } from '@nostrify/nostrify';
import { getCachedProfiles, cacheProfile } from '@/lib/cacheStore';

const BATCH_SIZE = 100;
const MAX_PREFETCH = 500;

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
  const isFetchingRef = useRef(false);

  const prefetchAuthors = useCallback(async (pubkeys: string[], signal?: AbortSignal) => {
    if (pubkeys.length === 0) return;

    // Prevent concurrent fetches — but auto-reset after 15s to prevent permanent stuck
    if (isFetchingRef.current) {
      return;
    }
    isFetchingRef.current = true;
    const safetyReset = setTimeout(() => { isFetchingRef.current = false; }, 15000);

    try {
      const uniquePubkeys = [...new Set(pubkeys)].slice(0, MAX_PREFETCH);
      
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
        if (import.meta.env.DEV) console.log('[bulkAuthors] All', uniquePubkeys.length, 'profiles found in cache');
        return;
      }
      
      if (import.meta.env.DEV) console.log('[bulkAuthors] Fetching', uncachedPubkeys.length, 'profiles from network...');
      
      const batches: string[][] = [];
      for (let i = 0; i < uncachedPubkeys.length; i += BATCH_SIZE) {
        batches.push(uncachedPubkeys.slice(i, i + BATCH_SIZE));
      }
      
      let fetched = 0;
      const fetchPromises = batches.map(async (batch) => {
        try {
          const events = await nostr.query(
            [{ kinds: [0], authors: batch, limit: batch.length }],
            { signal: signal ?? AbortSignal.timeout(8000) }
          );
          
          for (const event of events) {
            try {
              const metadata = n.json().pipe(n.metadata()).parse(event.content);
              
              queryClient.setQueryData(['author', event.pubkey], {
                metadata,
                event,
              });
              
              cacheProfile(event.pubkey, metadata, event).catch(() => {});
              fetched++;
            } catch {
              // Invalid metadata, skip
            }
          }
        } catch (err) {
          console.warn('[bulkAuthors] Batch failed:', err);
        }
      });
      
      await Promise.allSettled(fetchPromises);
      if (import.meta.env.DEV) console.log('[bulkAuthors] Fetched', fetched, 'profiles from network');
    } finally {
      clearTimeout(safetyReset);
      isFetchingRef.current = false;
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
