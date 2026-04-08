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

  // Publish updated mute list
  const publishMuteList = useCallback(
    async (newTags: string[][]) => {
      const event = await createEvent({
        kind: 10000,
        content: muteEvent?.content ?? '', // preserve any encrypted private section
        tags: newTags,
      });
      queryClient.setQueryData(queryKey, event);
      return event;
    },
    [createEvent, muteEvent, queryClient, queryKey],
  );

  const mute = useCallback(
    async (pubkey: string) => {
      const existing = muteEvent?.tags ?? [];
      if (existing.some(t => t[0] === 'p' && t[1] === pubkey)) return;
      await publishMuteList([...existing, ['p', pubkey]]);
    },
    [muteEvent, publishMuteList],
  );

  const unmute = useCallback(
    async (pubkey: string) => {
      const existing = muteEvent?.tags ?? [];
      await publishMuteList(existing.filter(t => !(t[0] === 'p' && t[1] === pubkey)));
    },
    [muteEvent, publishMuteList],
  );

  return { mutedPubkeys, isMuted, mute, unmute };
}
