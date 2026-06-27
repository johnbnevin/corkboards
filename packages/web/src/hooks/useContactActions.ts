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
import { resolveContactBase, applyContactChange } from '@core/contactList';
import { useNostr } from '@/hooks/useNostr';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';

export interface ContactOp { add?: string; remove?: string }
export interface ContactSuccessMsg { title: string; description?: string }

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

    const base = await resolveContactBase(nostr, user.pubkey, contacts, op.remove ? 'remove' : 'add');
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

    createEvent({ kind: 3, content: result.content, tags: result.tags });
    queryClient.setQueryData(['contacts', user.pubkey], result.pubkeys);
    toast(successMsg);
  }, [user?.pubkey, contacts, nostr, createEvent, queryClient, toast]);

  return safeUpdateContacts;
}
