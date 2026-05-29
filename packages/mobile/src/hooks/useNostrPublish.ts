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
import { useAppContext } from './useAppContext';

// created_at is auto-filled by the hook when omitted, so callers don't need to provide it.
type PublishInput = Omit<NostrEvent, 'id' | 'pubkey' | 'sig' | 'created_at'> & { created_at?: number };

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, PublishInput> {
  const { nostr } = useNostr();
  const { signer } = useAuth();
  const { config } = useAppContext();

  return useMutation({
    mutationFn: async (t: PublishInput) => {
      if (!signer) {
        throw new Error('Not logged in');
      }

      const tags = [...(t.tags ?? [])];

      // Client tag is OFF by default — attaching it to every event creates
      // fingerprintable metadata that lives forever in the public relay record.
      // Opt-in via settings (parity with web's useNostrPublish). Skip kind 0
      // (profile metadata) regardless — some relays reject extra tags there.
      if (config.publishClientTag === true && t.kind !== 0 && !tags.some(([name]) => name === 'client')) {
        tags.push(['client', 'corkboards.me']);
      }

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
