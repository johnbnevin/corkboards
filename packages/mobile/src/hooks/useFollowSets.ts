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
  const { pubkey, signer } = useAuth();

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

  // NIP-51 private section: members encrypted (NIP-44, to self) into each set's
  // `content`. Decrypt per d-tag so a fully-private set isn't dropped and
  // partially-private sets show all members. Degrades to public-only on failure.
  const { data: privateByDTag } = useQuery({
    queryKey: ['follow-sets-private', pubkey, (rawEvents ?? []).map(e => e.id).sort().join(',')],
    queryFn: async (): Promise<Record<string, string[]>> => {
      if (!pubkey || !signer?.nip44 || !rawEvents?.length) return {};
      const out: Record<string, string[]> = {};
      for (const ev of rawEvents) {
        if (!ev.content) continue;
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
        try {
          const decrypted = await signer.nip44.decrypt(pubkey, ev.content);
          const tags = JSON.parse(decrypted) as string[][];
          const pks = tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
          out[dTag] = [...(out[dTag] ?? []), ...pks];
        } catch {
          /* skip this set's private section */
        }
      }
      return out;
    },
    enabled: !!pubkey && !!rawEvents?.length,
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
        const publicPubkeys = ev.tags.filter(t => t[0] === 'p').map(t => t[1]);
        const pubkeys = [...new Set([...publicPubkeys, ...(privateByDTag?.[dTag] ?? [])])];
        return { name: title || dTag || 'Unnamed', dTag, pubkeys };
      })
      .filter(l => l.pubkeys.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rawEvents, privateByDTag]);

  return { lists, isLoading };
}
