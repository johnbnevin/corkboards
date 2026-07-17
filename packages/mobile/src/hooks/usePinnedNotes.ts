/**
 * NIP-51 Pinned Notes (kind 10001).
 *
 * Port of packages/web/src/hooks/usePinnedNotes.ts for mobile.
 * Uses MMKV instead of IDB for local cache, mobile AuthContext + NostrProvider.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr, getUserRelays, FALLBACK_RELAYS, createRelayFresh } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';
import type { NostrEvent } from '@nostrify/nostrify';
import { normalizeRelay } from '@core/normalizeRelay';

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

  // Fetch pin list (kind 10001) from relays — query ALL write relays and
  // pick the newest event by created_at. Promise.any() previously raced
  // relays and could return stale data from a fast-but-outdated relay.
  const { data: pinListResult, isLoading: isLoadingPinList } = useQuery({
    queryKey: ['pinned-notes', pubkey],
    queryFn: async (): Promise<{ ids: string[]; status: 'found' | 'none' | 'no-list'; relayHints: Record<string, string> }> => {
      if (!pubkey) return { ids: [], status: 'no-list', relayHints: {} };

      const userRelays = getUserRelays();
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS;

      // Query all write relays in parallel, collect all responses
      const results = await Promise.allSettled(
        writeRelays.map(async (relayUrl) => {
          const relay = createRelayFresh(normalizeRelay(relayUrl), { backoff: false });
          try {
            const events = await relay.query(
              [{ kinds: [10001], authors: [pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(8000) }
            );
            return events.filter(ev => ev.kind === 10001);
          } finally {
            try { relay.close(); } catch { /* */ }
          }
        })
      );

      // Pick the newest kind 10001 event across all relays
      let best: NostrEvent | null = null;
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const ev of r.value) {
          if (!best || ev.created_at > best.created_at) best = ev;
        }
      }

      if (!best) return { ids: [], status: 'no-list', relayHints: {} };

      const eTags = best.tags.filter(t => t[0] === 'e' && t[1]);
      const ids = eTags.map(t => t[1]);
      // Extract per-note relay hints from the e-tags (["e", id, relay-hint])
      const relayHints: Record<string, string> = {};
      for (const t of eTags) {
        if (t[2]) relayHints[t[1]] = t[2];
      }

      if (ids.length === 0) return { ids: [], status: 'none', relayHints: {} };
      return { ids, status: 'found', relayHints };
    },
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000,
  });

  // Sync local pinned-ids state when relay data arrives — hydration pattern.
  /* eslint-disable react-hooks/set-state-in-effect */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  const pinnedNotesStatus: 'loading' | 'found' | 'none' | 'no-list' = isLoadingPinList ? 'loading' : (pinListResult?.status ?? 'no-list');

  // Fetch actual pinned note events — use NPool (outbox routing + fallback relays
  // in parallel) instead of querying only the user's write relays sequentially.
  // Notes pinned from other authors live on their relays, not the user's write relays.
  const { data: pinnedNoteEvents, isLoading: isLoadingPinnedEvents } = useQuery({
    queryKey: ['pinned-note-events', pinnedIds],
    queryFn: async () => {
      if (pinnedIds.length === 0) return [];

      const found = new Map<string, NostrEvent>();

      // Primary: NPool routes to outbox relays + fallbacks in parallel
      try {
        const events = await nostr.query(
          [{ ids: pinnedIds }],
          { signal: AbortSignal.timeout(10000) }
        );
        events.forEach((ev: NostrEvent) => found.set(ev.id, ev));
      } catch { /* pool failed — fall through to hint relays */ }

      // Fallback 1: for notes still missing, try relay hints embedded in the pin list
      const missing = pinnedIds.filter(id => !found.has(id));
      if (missing.length > 0) {
        const cached = queryClient.getQueryData<{ relayHints: Record<string, string> }>(
          ['pinned-notes', pubkey]
        );
        const hints = cached?.relayHints ?? {};
        const hinted = missing.filter(id => hints[id]);
        if (hinted.length > 0) {
          await Promise.allSettled(
            hinted.map(async id => {
              const relay = createRelayFresh(normalizeRelay(hints[id]), { backoff: false });
              try {
                const evs = await relay.query([{ ids: [id] }], { signal: AbortSignal.timeout(5000) });
                evs.forEach((ev: NostrEvent) => found.set(ev.id, ev));
              } catch { /* skip */ }
              finally { try { relay.close(); } catch { /* */ } }
            })
          );
        }
      }

      // Fallback 2: still missing — query write relays directly (covers cold-cache sessions
      // where the NPool hasn't routed to the right relays yet)
      const stillMissing = pinnedIds.filter(id => !found.has(id));
      if (stillMissing.length > 0) {
        const userRelays = getUserRelays();
        const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS;
        for (const relayUrl of writeRelays) {
          const needIds = stillMissing.filter(id => !found.has(id));
          if (needIds.length === 0) break;
          try {
            const relay = createRelayFresh(normalizeRelay(relayUrl), { backoff: false });
            try {
              const evs = await relay.query([{ ids: needIds }], { signal: AbortSignal.timeout(5000) });
              evs.forEach((ev: NostrEvent) => found.set(ev.id, ev));
            } finally {
              try { relay.close(); } catch { /* */ }
            }
          } catch { /* try next */ }
        }
      }

      return pinnedIds.map(id => found.get(id)).filter((n): n is NostrEvent => !!n);
    },
    enabled: pinnedIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // Publish updated kind 10001 pin list directly to each relay.
  // Uses fresh createRelay connections instead of the NPool to avoid stale
  // WebSocket issues after idle periods that caused unpins to be lost.
  const publishPinList = useCallback(async (newIds: string[]) => {
    if (!signer) return;

    // Preserve each pin's relay hint (["e", id, relay-hint]). The read path
    // relies on these hints to locate notes pinned from other authors; rebuilding
    // bare ["e", id] tags on every pin/unpin would strip them all. (H3)
    const hints = pinListResult?.relayHints ?? {};
    const tags = newIds.map(id => (hints[id] ? ['e', id, hints[id]] : ['e', id]));
    const event = await signer.signEvent({
      kind: 10001,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });

    const userRelays = getUserRelays();
    const relays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS;
    let published = 0;
    await Promise.allSettled(
      relays.map(async (url) => {
        const relay = createRelayFresh(normalizeRelay(url), { backoff: false });
        try {
          await relay.event(event, { signal: AbortSignal.timeout(8000) });
          published++;
        } catch (err) {
          console.warn(`[pinnedNotes] ${url} rejected:`, err);
        } finally {
          try { relay.close(); } catch { /* */ }
        }
      })
    );
    if (published === 0) {
      console.error('[pinnedNotes] No relays accepted the pin list update');
    }
  }, [signer, pinListResult]);

  // Toggle pin: add or remove, publish, update local + set optimistic cache.
  const togglePin = useCallback(async (noteId: string) => {
    if (!pubkey || !signer) return;

    const currentIds = [...pinnedIds];
    const isUnpin = currentIds.includes(noteId);
    const newIds = isUnpin
      ? currentIds.filter(id => id !== noteId)
      : [...currentIds, noteId];

    // Pre-seed pinned events cache for the new key so the tab doesn't flash
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
