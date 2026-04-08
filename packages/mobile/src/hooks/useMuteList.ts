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

  const queryKey = ['mute-list', pubkey];

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

  // Extract muted pubkeys from p-tags
  const mutedPubkeys = useMemo(() => {
    if (!muteEvent) return new Set<string>();
    return new Set(
      muteEvent.tags.filter(t => t[0] === 'p').map(t => t[1]),
    );
  }, [muteEvent]);

  const isMuted = useCallback(
    (pk: string) => mutedPubkeys.has(pk),
    [mutedPubkeys],
  );

  // Publish updated mute list
  const mute = useCallback(
    async (pk: string) => {
      if (!signer || !pubkey) return;
      const existing = muteEvent?.tags ?? [];
      if (existing.some(t => t[0] === 'p' && t[1] === pk)) return;
      const newTags = [...existing, ['p', pk]];
      const event = await signer.signEvent({
        kind: 10000,
        content: muteEvent?.content ?? '', // preserve encrypted private section
        tags: newTags,
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(event);
      queryClient.setQueryData(queryKey, event);
    },
    [pubkey, signer, nostr, muteEvent, queryClient, queryKey],
  );

  const unmute = useCallback(
    async (pk: string) => {
      if (!signer || !pubkey) return;
      const existing = muteEvent?.tags ?? [];
      const newTags = existing.filter(t => !(t[0] === 'p' && t[1] === pk));
      const event = await signer.signEvent({
        kind: 10000,
        content: muteEvent?.content ?? '',
        tags: newTags,
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(event);
      queryClient.setQueryData(queryKey, event);
    },
    [pubkey, signer, nostr, muteEvent, queryClient, queryKey],
  );

  return { mutedPubkeys, isMuted, mute, unmute };
}
