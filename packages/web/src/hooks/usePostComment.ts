import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { type NostrEvent } from '@nostrify/nostrify';
import { buildCommentTags } from '@core/noteClassifier';
import { getRelayCache } from '@/components/NostrProvider';
import { FALLBACK_RELAYS } from '@/lib/relayConstants';

interface PostCommentParams {
  root: NostrEvent | URL; // The root event to comment on
  reply?: NostrEvent | URL; // Optional reply to another comment
  content: string;
}

/** Relay hint for an author: their own outbox relay when we know it, else the
 *  first shared fallback — a hint the reader can actually reach beats none. */
function relayHintFor(pubkey: string): string {
  return getRelayCache(pubkey)?.[0] || FALLBACK_RELAYS[0] || '';
}

/** Post a NIP-22 (kind 1111) comment on an event.
 *  Scope-tag construction lives in @core/noteClassifier so web and mobile emit
 *  identical tags — including the relay hints and author pubkeys NIP-22 asks
 *  for, which are what let another client resolve the parent it doesn't hold. */
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
      // Invalidate and refetch comments
      queryClient.invalidateQueries({
        queryKey: ['nostr', 'comments', root instanceof URL ? root.toString() : root.id]
      });
    },
  });
}
