/**
 * NIP-51 Mute list (kind 10000).
 *
 * Fetches the user's mute list from relays and provides functions to
 * add/remove pubkeys. Changes are published as replaceable events.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';

export function useMuteList(fetchEnabled = true) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser(false);
  const queryClient = useQueryClient();
  const { mutateAsync: createEvent } = useNostrPublish();

  const queryKey = useMemo(() => ['mute-list', user?.pubkey], [user?.pubkey]);

  const { data: muteEvent } = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!user?.pubkey) return null;
      const events = await nostr.query(
        [{ kinds: [10000], authors: [user.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events.length > 0
        ? events.reduce((best, e) => (e.created_at > best.created_at ? e : best))
        : null;
    },
    enabled: !!user?.pubkey && fetchEnabled,
    staleTime: 5 * 60_000,
  });

  // NIP-51 private section: mutes other clients encrypted into `content`
  // (NIP-44, to self). Decrypt them so a privately-muted person is actually
  // hidden here too — not just the public p-tags. Failure (no nip44, bad
  // ciphertext) degrades to public-only rather than throwing.
  const { data: privateMutedPubkeys } = useQuery({
    queryKey: ['mute-list-private', user?.pubkey, muteEvent?.id],
    queryFn: async (): Promise<string[]> => {
      if (!user?.pubkey || !muteEvent?.content || !user.signer.nip44) return [];
      try {
        const decrypted = await user.signer.nip44.decrypt(user.pubkey, muteEvent.content);
        const tags = JSON.parse(decrypted) as string[][];
        return tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
      } catch {
        return [];
      }
    },
    enabled: !!user?.pubkey && !!muteEvent?.content,
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
    (pubkey: string) => mutedPubkeys.has(pubkey),
    [mutedPubkeys],
  );

  // Re-fetch the authoritative kind-10000 at action time. The cached query can be
  // undefined/stale after a transient relay miss; publishing off that would
  // republish a truncated list and WIPE the user's real mutes. Mirror the kind-3
  // contact-list safety pattern: confirm the current list before mutating it. (C2)
  const resolveMuteBase = useCallback(
    async (): Promise<{ tags: string[][]; content: string } | null> => {
      if (!user?.pubkey) return null;
      let authoritative = muteEvent ?? null;
      try {
        const events = await nostr.query(
          [{ kinds: [10000], authors: [user.pubkey], limit: 1 }],
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
    [user?.pubkey, muteEvent, nostr],
  );

  // Publish updated mute list. `content` preserves any encrypted private section.
  const publishMuteList = useCallback(
    async (newTags: string[][], content?: string) => {
      const event = await createEvent({
        kind: 10000,
        content: content ?? muteEvent?.content ?? '',
        tags: newTags,
      });
      queryClient.setQueryData(queryKey, event);
      return event;
    },
    [createEvent, muteEvent, queryClient, queryKey],
  );

  const mute = useCallback(
    async (pubkey: string) => {
      const base = await resolveMuteBase();
      if (!base) {
        // Symmetric with unmute below. `mute` used to fall back to
        // `muteEvent?.tags ?? []` here, which meant an unconfirmable list was
        // treated as an EMPTY one — and kind 10000 is replaceable, so
        // publishing from that base replaced every existing mute with the one
        // being added. `content` went out as '' too, destroying the NIP-51
        // encrypted private-mute section. `muteEvent` is nullish whenever the
        // query hasn't run yet, which on web is the default: the hook is gated
        // by `useMuteList(profileFetchEnabled)` and that flag starts false.
        throw new Error('Could not confirm mute list; mute aborted to avoid data loss');
      }
      if (base.tags.some(t => t[0] === 'p' && t[1] === pubkey)) return;
      await publishMuteList([...base.tags, ['p', pubkey]], base.content);
    },
    [resolveMuteBase, publishMuteList],
  );

  const unmute = useCallback(
    async (pubkey: string) => {
      const base = await resolveMuteBase();
      if (!base) {
        // Couldn't confirm the current list — refuse the removal rather than
        // republish an empty list and lose every mute we just failed to fetch.
        throw new Error('Could not confirm mute list; unmute aborted to avoid data loss');
      }
      await publishMuteList(
        base.tags.filter(t => !(t[0] === 'p' && t[1] === pubkey)),
        base.content,
      );
    },
    [resolveMuteBase, publishMuteList],
  );

  return { mutedPubkeys, isMuted, mute, unmute };
}
