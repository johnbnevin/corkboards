/**
 * NIP-51 Mute list (kind 10000).
 *
 * Fetches the user's mute list from relays and provides functions to
 * add/remove pubkeys. Changes are published as replaceable events.
 *
 * Mirrors the web version (packages/web/src/hooks/useMuteList.ts).
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

export function useMuteList(fetchEnabled = true) {
  const { nostr } = useNostr();
  const { pubkey, signer } = useAuth();
  const queryClient = useQueryClient();

  const queryKey = useMemo(() => ['mute-list', pubkey] as const, [pubkey]);

  const { data: muteEvent } = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!pubkey) return null;
      const events = await nostr.query(
        [{ kinds: [10000], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events.length > 0
        ? events.reduce((best, e) => (e.created_at > best.created_at ? e : best))
        : null;
    },
    enabled: !!pubkey && fetchEnabled,
    staleTime: 5 * 60_000,
  });

  // NIP-51 private section: mutes other clients encrypted into `content`
  // (NIP-44, to self). Decrypt them so a privately-muted person is hidden here
  // too — not just the public p-tags. Failure degrades to public-only.
  const { data: privateMutedPubkeys } = useQuery({
    queryKey: ['mute-list-private', pubkey, muteEvent?.id],
    queryFn: async (): Promise<string[]> => {
      if (!pubkey || !muteEvent?.content || !signer?.nip44) return [];
      try {
        const decrypted = await signer.nip44.decrypt(pubkey, muteEvent.content);
        const tags = JSON.parse(decrypted) as string[][];
        return tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
      } catch {
        return [];
      }
    },
    enabled: !!pubkey && !!muteEvent?.content,
    staleTime: 5 * 60_000,
  });

  // Muted pubkeys = public p-tags ∪ decrypted private p-tags.
  const mutedPubkeys = useMemo(() => {
    const set = new Set<string>();
    if (muteEvent) {
      for (const t of muteEvent.tags) if (t[0] === 'p' && t[1]) set.add(t[1]);
    }
    if (privateMutedPubkeys) {
      for (const pk of privateMutedPubkeys) set.add(pk);
    }
    return set;
  }, [muteEvent, privateMutedPubkeys]);

  const isMuted = useCallback(
    (pk: string) => mutedPubkeys.has(pk),
    [mutedPubkeys],
  );

  // Re-fetch the authoritative kind-10000 at action time. The cached query can be
  // undefined/stale after a transient relay miss; publishing off that would
  // republish a truncated list and WIPE the user's real mutes. Mirror the kind-3
  // contact-list safety pattern: confirm the current list before mutating it. (C2)
  const resolveMuteBase = useCallback(
    async (): Promise<{ tags: string[][]; content: string } | null> => {
      if (!pubkey) return null;
      let authoritative = muteEvent ?? null;
      try {
        const events = await nostr.query(
          [{ kinds: [10000], authors: [pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(8000) },
        );
        const newest = events.length > 0
          ? events.reduce((best, e) => (e.created_at > best.created_at ? e : best))
          : null;
        if (newest && (!authoritative || newest.created_at >= authoritative.created_at)) {
          authoritative = newest;
        }
      } catch {
        // Network failure — fall back to whatever we have cached below.
      }
      if (!authoritative) return null;
      return { tags: authoritative.tags, content: authoritative.content };
    },
    [pubkey, muteEvent, nostr],
  );

  const publishMuteList = useCallback(
    async (newTags: string[][], content?: string) => {
      if (!signer || !pubkey) return;
      const event = await signer.signEvent({
        kind: 10000,
        content: content ?? muteEvent?.content ?? '', // preserve encrypted private section
        tags: newTags,
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(event);
      queryClient.setQueryData(queryKey, event);
    },
    [pubkey, signer, nostr, muteEvent, queryClient, queryKey],
  );

  const mute = useCallback(
    async (pk: string) => {
      if (!signer || !pubkey) return;
      const base = await resolveMuteBase();
      if (!base) {
        // Symmetric with unmute below, and identical to web's useMuteList.
        // Falling back to `muteEvent?.tags ?? []` treated an unconfirmable list
        // as an EMPTY one; kind 10000 is replaceable, so publishing from that
        // base replaced every existing mute with the one being added and sent
        // `content: ''`, destroying the NIP-51 encrypted private-mute section.
        throw new Error('Could not confirm mute list; mute aborted to avoid data loss');
      }
      if (base.tags.some(t => t[0] === 'p' && t[1] === pk)) return;
      await publishMuteList([...base.tags, ['p', pk]], base.content);
    },
    [pubkey, signer, resolveMuteBase, publishMuteList],
  );

  const unmute = useCallback(
    async (pk: string) => {
      if (!signer || !pubkey) return;
      const base = await resolveMuteBase();
      if (!base) {
        // Couldn't confirm the current list — refuse the removal rather than
        // republish an empty list and lose every mute we just failed to fetch.
        throw new Error('Could not confirm mute list; unmute aborted to avoid data loss');
      }
      await publishMuteList(
        base.tags.filter(t => !(t[0] === 'p' && t[1] === pk)),
        base.content,
      );
    },
    [pubkey, signer, resolveMuteBase, publishMuteList],
  );

  return { mutedPubkeys, isMuted, mute, unmute };
}
