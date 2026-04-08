/**
 * useNostrPublish — sign and publish a Nostr event.
 *
 * Publishing is considered successful once the event is signed.
 * Relay failures are logged but don't fail the mutation, since the event
 * may have been accepted by at least one relay before any error occurred.
 *
 * Mirrors packages/web/src/hooks/useNostrPublish.ts.
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>> {
  const { nostr } = useNostr();
  const { signer } = useAuth();

  return useMutation({
    mutationFn: async (t: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>) => {
      if (!signer) {
        throw new Error('Not logged in');
      }

      const tags = [...(t.tags ?? [])];

      // Client tag omitted by default to avoid fingerprinting users.
      // (Opt-in via settings, matching web behavior.)

      const event = await signer.signEvent({
        kind: t.kind,
        content: t.content ?? '',
        tags,
        created_at: t.created_at ?? Math.floor(Date.now() / 1000),
      });

      // Publish — don't fail if some relays reject
      try {
        await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      } catch (err) {
        if (__DEV__) console.warn('[useNostrPublish] Some relays may have rejected the event:', err);
      }

      return event;
    },
  });
}
