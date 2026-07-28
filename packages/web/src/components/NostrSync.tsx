import { useEffect, useRef } from 'react';
import { useNostr } from '@nostrify/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import { isSecureRelay } from '@core/nostrUtils';
import { normalizeRelay } from '@core/normalizeRelay';

/**
 * NostrSync - Syncs user's Nostr data
 *
 * This component runs globally to sync various Nostr data when the user logs in.
 * Currently syncs:
 * - NIP-65 relay list (kind 10002)
 */
export function NostrSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  // Track the updatedAt value we last queried for — prevents a redundant re-query
  // that would otherwise fire when our own updateConfig call changes updatedAt.
  const lastQueriedUpdatedAt = useRef<number>(-1);
  // Which account the currently-held relayMetadata belongs to.
  const relayMetadataPubkey = useRef<string | null>(null);

  // Reset the stored NIP-65 list whenever the ACTIVE ACCOUNT changes.
  //
  // `corkboard:app-config` is a single global blob — unlike the per-user keys in
  // @core/storageKeys it is NOT stashed/restored on account switch. So account
  // A's relay list survived into account B's session, where it did two harmful
  // things: it routed B's reads and writes through relays only A chose (a
  // cross-account correlation leak — B's queries carry B's follow graph to A's
  // servers), and it seeded the relay editor with A's list so B's next edit
  // published a kind-10002 that CLOBBERED B's real relay list with A's.
  //
  // Zeroing `updatedAt` (not just the relays) is what lets the sync below
  // re-adopt B's own event: the guard is `event.created_at > updatedAt`, and A's
  // timestamp can easily be newer than B's list.
  useEffect(() => {
    const pubkey = user?.pubkey ?? null;
    if (relayMetadataPubkey.current === pubkey) return;
    const previous = relayMetadataPubkey.current;
    relayMetadataPubkey.current = pubkey;
    // First observation this session is not a switch — the persisted config
    // legitimately belongs to whoever is logged in. Only a real change wipes.
    if (previous === null) return;
    lastQueriedUpdatedAt.current = -1;
    updateConfig((current) => ({
      ...current,
      relayMetadata: { relays: [], updatedAt: 0 },
    }));
  }, [user?.pubkey, updateConfig]);

  useEffect(() => {
    if (!user) return;
    // Skip if we already ran a query for this exact updatedAt (avoids the
    // self-triggered re-run after we update the config).
    if (config.relayMetadata.updatedAt === lastQueriedUpdatedAt.current) return;
    lastQueriedUpdatedAt.current = config.relayMetadata.updatedAt;

    const syncRelaysFromNostr = async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [10002], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );

        if (events.length > 0) {
          const event = events[0];
          // A relay answering with SOMEONE ELSE's 10002 must never become "our"
          // relay list — it is signed straight back out on the next edit.
          if (event.pubkey !== user.pubkey) return;

          // Only update if the event is newer than our stored data
          if (event.created_at > config.relayMetadata.updatedAt) {
            const fetchedRelays = event.tags
              .filter(([name]) => name === 'r')
              .map(([_, url, marker]) => ({
                url: typeof url === 'string' ? normalizeRelay(url) : '',
                read: !marker || marker === 'read',
                write: !marker || marker === 'write',
              }))
              // Validate BEFORE storing. Whatever lands here is what the relay
              // editor shows AND what the next kind-10002 publish contains, so a
              // `ws://` or private/LAN address — in a stale list or injected by a
              // hostile relay — would be adopted as the user's own and
              // republished under their signature. Same gate the relay cache and
              // getUserRelays() already apply on their write paths.
              .filter((r) => isSecureRelay(r.url));

            if (fetchedRelays.length > 0) {
              updateConfig((current) => ({
                ...current,
                relayMetadata: {
                  relays: fetchedRelays,
                  updatedAt: event.created_at,
                },
              }));
            }
          }
        }
      } catch (error) {
        if (import.meta.env.DEV) console.error('Failed to sync relays from Nostr:', error);
      }
    };

    syncRelaysFromNostr();
  }, [user, config.relayMetadata.updatedAt, nostr, updateConfig]);

  return null;
}
