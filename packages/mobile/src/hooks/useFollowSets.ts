/**
 * NIP-51 Follow Sets (kind 30000).
 *
 * Port of packages/web/src/hooks/useFollowSets.ts for mobile.
 * Fetches the user's categorized people lists from relays.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

export interface FollowSet {
  name: string;
  dTag: string;
  pubkeys: string[];
}

export function useFollowSets(fetchEnabled = true) {
  const { nostr } = useNostr();
  const { pubkey } = useAuth();

  const { data: rawEvents, isLoading } = useQuery({
    queryKey: ['follow-sets', pubkey],
    queryFn: async ({ signal }) => {
      if (!pubkey) return [];
      return nostr.query(
        [{ kinds: [30000], authors: [pubkey] }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
    },
    enabled: !!pubkey && fetchEnabled,
    staleTime: 5 * 60_000,
  });

  const lists = useMemo<FollowSet[]>(() => {
    if (!rawEvents?.length) return [];
    // Deduplicate by d-tag — keep newest event per d-tag
    const byDTag = new Map<string, typeof rawEvents[0]>();
    for (const ev of rawEvents) {
      const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
      const existing = byDTag.get(dTag);
      if (!existing || ev.created_at > existing.created_at) {
        byDTag.set(dTag, ev);
      }
    }
    return Array.from(byDTag.values())
      .map(ev => {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
        const title = ev.tags.find(t => t[0] === 'title')?.[1];
        const pubkeys = ev.tags.filter(t => t[0] === 'p').map(t => t[1]);
        return { name: title || dTag || 'Unnamed', dTag, pubkeys };
      })
      .filter(l => l.pubkeys.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rawEvents]);

  return { lists, isLoading };
}
