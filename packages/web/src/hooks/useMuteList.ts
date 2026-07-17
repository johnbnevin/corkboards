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

  // Extract muted pubkeys from p-tags
  const mutedPubkeys = useMemo(() => {
    if (!muteEvent) return new Set<string>();
    return new Set(
      muteEvent.tags.filter(t => t[0] === 'p').map(t => t[1]),
    );
  }, [muteEvent]);

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
      const existing = base?.tags ?? muteEvent?.tags ?? [];
      if (existing.some(t => t[0] === 'p' && t[1] === pubkey)) return;
      await publishMuteList([...existing, ['p', pubkey]], base?.content);
    },
    [resolveMuteBase, muteEvent, publishMuteList],
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
