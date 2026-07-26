/**
 * useContactActions — safe kind-3 (NIP-02) follow-list mutation.
 *
 * Extracted from MultiColumnClient so this data-loss-sensitive logic lives in
 * one small, focused place. `safeUpdateContacts` re-reads the authoritative
 * contact event from relays at click time (preserving every follow's relay
 * hint + petname + the event content via @core/contactList), refuses a removal
 * it can't confirm, and optimistically updates the contacts cache. The pure
 * resolve/apply logic is shared verbatim with mobile.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveContactBase, applyContactChange, type ContactBase } from '@core/contactList';
import { withKeyedLock } from '@core/keyedMutex';
import { useNostr } from '@/hooks/useNostr';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';

export interface ContactOp { add?: string; remove?: string }
export interface ContactSuccessMsg { title: string; description?: string }

/**
 * The base we last published for a pubkey, kept briefly so a burst of
 * follow/unfollow clicks accumulates instead of each re-reading the same relay
 * state (the previous click's kind-3 hasn't propagated yet) and clobbering the
 * one before it. Shared across hook instances on purpose. Outside the window we
 * fall back to the safety-first relay re-read, so a later edit — including one
 * from another client — is still picked up.
 */
const recentBaseByPubkey = new Map<string, { base: ContactBase; at: number }>();
const RECENT_BASE_MS = 15_000;

export function useContactActions(
  user: { pubkey?: string } | null | undefined,
  contacts: string[] | undefined,
) {
  const { nostr } = useNostr();
  const { mutate: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const safeUpdateContacts = useCallback(async (
    op: ContactOp,
    successMsg: ContactSuccessMsg,
  ): Promise<void> => {
    if (!user?.pubkey) return;
    const pubkey = user.pubkey;

    // Serialize per-user: two quick follow/unfollow clicks are read-modify-writes
    // on the same replaceable kind-3, and unserialized the second publish (newer,
    // built from a base missing the first's change) clobbers the first.
    await withKeyedLock(`kind3:${pubkey}`, async () => {
      const recent = recentBaseByPubkey.get(pubkey);
      const base = recent && Date.now() - recent.at < RECENT_BASE_MS
        ? recent.base // build on our own most recent write, not an un-propagated relay
        : await resolveContactBase(nostr, pubkey, contacts, op.remove ? 'remove' : 'add');
      if (base === null) {
        toast({
          title: "Couldn't update follows",
          description: 'Could not load your current follow list. Please try again.',
          variant: 'destructive',
        });
        return;
      }

      const result = applyContactChange(base, op);
      if (!result) return; // no-op (already following / already not following)

      recentBaseByPubkey.set(pubkey, { base: { tags: result.tags, content: result.content }, at: Date.now() });
      createEvent({ kind: 3, content: result.content, tags: result.tags });
      queryClient.setQueryData(['contacts', pubkey], result.pubkeys);
      toast(successMsg);
    });
  }, [user?.pubkey, contacts, nostr, createEvent, queryClient, toast]);

  return safeUpdateContacts;
}
