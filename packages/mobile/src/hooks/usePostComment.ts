/**
 * Post a NIP-22 (kind 1111) comment on an event.
 *
 * Port of packages/web/src/hooks/usePostComment.ts for mobile. Scope-tag
 * construction lives in @core/noteClassifier so both platforms emit identical
 * tags — including the relay hints and author pubkeys NIP-22 asks for, which
 * are what let another client resolve a parent it doesn't already hold.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNostrPublish } from './useNostrPublish';
import { type NostrEvent } from '@nostrify/nostrify';
import { buildCommentTags } from '@core/noteClassifier';
import { getRelayCache } from '../lib/NostrProvider';
import { FALLBACK_RELAYS } from '../lib/relayConstants';

interface PostCommentParams {
  root: NostrEvent | URL;
  reply?: NostrEvent | URL;
  content: string;
}

/** Relay hint for an author: their own outbox relay when we know it, else the
 *  first shared fallback — a hint the reader can actually reach beats none. */
function relayHintFor(pubkey: string): string {
  return getRelayCache(pubkey)?.[0] || FALLBACK_RELAYS[0] || '';
}

export function usePostComment() {
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ root, reply, content }: PostCommentParams) => {
      const event = await publishEvent({
        kind: 1111,
        content,
        tags: buildCommentTags(root, reply, relayHintFor),
      });

      return event;
    },
    onSuccess: (_, { root }) => {
      queryClient.invalidateQueries({
        queryKey: ['nostr', 'comments', root instanceof URL ? root.toString() : root.id]
      });
    },
  });
}
