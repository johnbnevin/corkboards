/**
 * NIP-51 Follow Sets (kind 30000).
 *
 * Fetches the user's categorized people lists from relays.
 * Each list has a d-tag identifier, optional title, and p-tag members.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { useCurrentUser } from '@/hooks/useCurrentUser';

export interface FollowSet {
  name: string;
  dTag: string;
  pubkeys: string[];
}

export function useFollowSets(fetchEnabled = true) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser(false);

  const { data: rawEvents, isLoading } = useQuery({
    queryKey: ['follow-sets', user?.pubkey],
    queryFn: async ({ signal }) => {
      if (!user?.pubkey) return [];
      return nostr.query(
        [{ kinds: [30000], authors: [user.pubkey] }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
    },
    enabled: !!user?.pubkey && fetchEnabled,
    staleTime: 5 * 60_000,
  });

  // NIP-51 private section: members encrypted (NIP-44, to self) into each set's
  // `content`. Decrypt per d-tag so a set that is entirely private isn't dropped,
  // and partially-private sets show all their members. Failure degrades to
  // public-only. Keyed on the event ids so it refreshes when the sets change.
  const { data: privateByDTag } = useQuery({
    queryKey: ['follow-sets-private', user?.pubkey, (rawEvents ?? []).map(e => e.id).sort().join(',')],
    queryFn: async (): Promise<Record<string, string[]>> => {
      if (!user?.pubkey || !user.signer.nip44 || !rawEvents?.length) return {};
      const out: Record<string, string[]> = {};
      for (const ev of rawEvents) {
        if (!ev.content) continue;
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
        try {
          const decrypted = await user.signer.nip44.decrypt(user.pubkey, ev.content);
          const tags = JSON.parse(decrypted) as string[][];
          const pks = tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
          out[dTag] = [...(out[dTag] ?? []), ...pks];
        } catch {
          /* skip this set's private section */
        }
      }
      return out;
    },
    enabled: !!user?.pubkey && !!rawEvents?.length,
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
        // Public ∪ decrypted private members.
        const pubkeys = [...new Set([...publicPubkeys, ...(privateByDTag?.[dTag] ?? [])])];
        return { name: title || dTag || 'Unnamed', dTag, pubkeys };
      })
      .filter(l => l.pubkeys.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rawEvents, privateByDTag]);

  return { lists, isLoading };
}
