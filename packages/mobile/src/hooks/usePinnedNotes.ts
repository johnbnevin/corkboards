/**
 * NIP-51 Pinned Notes (kind 10001).
 *
 * Port of packages/web/src/hooks/usePinnedNotes.ts for mobile.
 * Uses MMKV instead of IDB for local cache, mobile AuthContext + NostrProvider.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr, getUserRelays, FALLBACK_RELAYS } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';
import type { NostrEvent } from '@nostrify/nostrify';

const MMKV_KEY = STORAGE_KEYS.PINNED_NOTE_IDS;

export function usePinnedNotes() {
  const { pubkey, signer } = useAuth();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const [pinnedIds, setPinnedIds] = useState<string[]>([]);

  const persistPendingRef = useRef(false);
  useEffect(() => {
    if (!persistPendingRef.current) return;
    persistPendingRef.current = false;
    try {
      mobileStorage.setSync(MMKV_KEY, JSON.stringify(pinnedIds));
    } catch (e) {
      console.error('[pinnedNotes] Failed to save to MMKV:', e);
    }
  }, [pinnedIds]);

  // Fetch pin list (kind 10001) from relays
  const { data: pinListResult, isLoading: isLoadingPinList } = useQuery({
    queryKey: ['pinned-notes', pubkey],
    queryFn: async (): Promise<{ ids: string[]; status: 'found' | 'none' | 'no-list' }> => {
      if (!pubkey) return { ids: [], status: 'no-list' };

      const userRelays = getUserRelays();
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS;

      let pinList: NostrEvent | null = null;
      try {
        pinList = await Promise.any(
          writeRelays.map(async (relayUrl) => {
            const relay = nostr.relay(relayUrl);
            const [ev] = await relay.query(
              [{ kinds: [10001], authors: [pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(3000) }
            );
            if (!ev) throw new Error('no pin list');
            return ev;
          })
        );
      } catch {
        return { ids: [], status: 'no-list' };
      }

      if (!pinList) return { ids: [], status: 'no-list' };
      if (pinList.kind !== 10001) return { ids: [], status: 'no-list' };

      const ids = pinList.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1]);

      if (ids.length === 0) return { ids: [], status: 'none' };
      return { ids, status: 'found' };
    },
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!pinListResult) return;
    if (pinListResult.ids.length > 0) {
      persistPendingRef.current = true;
      setPinnedIds(pinListResult.ids);
    } else if (pinListResult.status === 'none' || pinListResult.status === 'no-list') {
      setPinnedIds(prev => {
        if (prev.length === 0) return prev;
        persistPendingRef.current = true;
        return [];
      });
    }
  }, [pinListResult]);

  const pinnedNotesStatus: 'loading' | 'found' | 'none' | 'no-list' = isLoadingPinList ? 'loading' : (pinListResult?.status ?? 'no-list');

  // Fetch actual pinned note events
  const { data: pinnedNoteEvents, isLoading: isLoadingPinnedEvents } = useQuery({
    queryKey: ['pinned-note-events', pinnedIds],
    queryFn: async () => {
      if (pinnedIds.length === 0) return [];

      const userRelays = getUserRelays();
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS;
      const foundNotes: NostrEvent[] = [];

      for (const relayUrl of writeRelays) {
        try {
          const relay = nostr.relay(relayUrl);
          const missingIds = pinnedIds.filter(id => !foundNotes.some(n => n.id === id));
          if (missingIds.length === 0) break;
          const events = await relay.query(
            [{ ids: missingIds }],
            { signal: AbortSignal.timeout(3000) }
          );
          for (const ev of events) {
            if (!foundNotes.some(n => n.id === ev.id)) {
              foundNotes.push(ev);
            }
          }
        } catch {
          // Try next relay
        }
      }

      return pinnedIds
        .map(id => foundNotes.find(n => n.id === id))
        .filter((n): n is NostrEvent => !!n);
    },
    enabled: pinnedIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  const publishPinList = useCallback(async (newIds: string[]) => {
    if (!signer) return;

    const tags = newIds.map(id => ['e', id]);
    const event = await signer.signEvent({
      kind: 10001,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });

    try {
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
    } catch (err) {
      console.warn('[pinnedNotes] Some relays may have rejected:', err);
    }
  }, [signer, nostr]);

  // Toggle pin: add or remove, publish, update local + set optimistic cache.
  // We use setQueryData (not invalidateQueries) for the pin list to prevent
  // stale relay data from overwriting the optimistic state. We also pre-seed
  // the pinned-note-events cache so the me tab doesn't flash.
  const togglePin = useCallback(async (noteId: string) => {
    if (!pubkey || !signer) return;

    const currentIds = [...pinnedIds];
    const isUnpin = currentIds.includes(noteId);
    const newIds = isUnpin
      ? currentIds.filter(id => id !== noteId)
      : [...currentIds, noteId];

    // Pre-seed pinned events cache for the new key so the me tab doesn't flash
    const oldEvents = queryClient.getQueryData<NostrEvent[]>(['pinned-note-events', currentIds]) ?? [];
    if (isUnpin) {
      queryClient.setQueryData(['pinned-note-events', newIds], oldEvents.filter(e => e.id !== noteId));
    } else {
      queryClient.setQueryData(['pinned-note-events', newIds], oldEvents);
    }

    persistPendingRef.current = true;
    setPinnedIds(newIds);

    // Set optimistic pin list cache (prevents relay refetch from reverting)
    queryClient.setQueryData(['pinned-notes', pubkey],
      { ids: newIds, status: newIds.length > 0 ? 'found' as const : 'none' as const });

    await publishPinList(newIds);

    // After relay confirms, refetch events to pick up newly pinned notes
    queryClient.invalidateQueries({ queryKey: ['pinned-note-events'] });
  }, [pubkey, signer, pinnedIds, publishPinList, queryClient]);

  return {
    pinnedIds,
    pinnedSet,
    pinnedNotes: pinnedNoteEvents ?? [],
    pinnedNotesStatus,
    isLoading: isLoadingPinList || isLoadingPinnedEvents,
    isPinned: useCallback((noteId: string) => pinnedSet.has(noteId), [pinnedSet]),
    togglePin,
  };
}
