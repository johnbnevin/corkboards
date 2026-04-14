import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from '@nostrify/react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { idbSetSync } from '@/lib/idb'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import type { NostrEvent } from '@nostrify/nostrify'
import { NRelay1 } from '@nostrify/nostrify'
import { normalizeRelay } from '@core/normalizeRelay'

const IDB_KEY = STORAGE_KEYS.PINNED_NOTE_IDS

/**
 * Hook for managing NIP-51 pinned notes (kind 10001).
 *
 * - Reads the user's kind 10001 pin list from relays (source of truth)
 * - Fetches the actual pinned note events
 * - Publishes updated kind 10001 events on pin/unpin
 * - Caches pinned IDs in IDB after relay confirmation
 *
 * Note: We intentionally do NOT initialize from IDB cache on mount.
 * Stale IDB data (from previous sessions, account switches, or relay
 * misbehavior) caused saved/bookmarked notes to appear as pinned on
 * the me tab. The relay is always the source of truth for kind 10001.
 */
export function usePinnedNotes() {
  const { user } = useCurrentUser(false)
  const { nostr } = useNostr()
  const queryClient = useQueryClient()

  // Start empty — relay query populates. No IDB cache initialization.
  const [pinnedIds, setPinnedIds] = useState<string[]>([])

  // Persist to IDB after relay-confirmed or user-toggled changes
  const persistPendingRef = useRef(false)
  useEffect(() => {
    if (!persistPendingRef.current) return
    persistPendingRef.current = false
    try {
      idbSetSync(IDB_KEY, JSON.stringify(pinnedIds))
    } catch (e) {
      console.error('[pinnedNotes] Failed to save to IDB:', e)
    }
  }, [pinnedIds])

  // Fetch pin list (kind 10001) from relays — query ALL write relays and
  // pick the newest event by created_at. Promise.any() previously raced
  // relays and could return stale data from a fast-but-outdated relay.
  const { data: pinListResult, isLoading: isLoadingPinList } = useQuery({
    queryKey: ['pinned-notes', user?.pubkey],
    queryFn: async (): Promise<{ ids: string[]; status: 'found' | 'none' | 'no-list' }> => {
      if (!user?.pubkey) return { ids: [], status: 'no-list' }

      const userRelays = getUserRelays()
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS

      // Query all write relays in parallel, collect all responses
      const results = await Promise.allSettled(
        writeRelays.map(async (relayUrl) => {
          const relay = new NRelay1(normalizeRelay(relayUrl), { backoff: false })
          try {
            const events = await relay.query(
              [{ kinds: [10001], authors: [user.pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(4000) }
            )
            return events.filter(ev => ev.kind === 10001)
          } finally {
            try { relay.close() } catch { /* */ }
          }
        })
      )

      // Pick the newest kind 10001 event across all relays
      let best: NostrEvent | null = null
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const ev of r.value) {
          if (!best || ev.created_at > best.created_at) best = ev
        }
      }

      if (!best) return { ids: [], status: 'no-list' }

      const ids = best.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1])

      if (ids.length === 0) return { ids: [], status: 'none' }
      return { ids, status: 'found' }
    },
    enabled: !!user?.pubkey,
    staleTime: 5 * 60 * 1000,
  })

  // Sync local state when relay data arrives — relay is authoritative over IDB cache.
  // If relay returns empty (no pins or no list), clear stale IDB data to prevent
  // contaminated cache from persisting across reloads.
  useEffect(() => {
    if (!pinListResult) return
    if (pinListResult.ids.length > 0) {
      console.log(`[pinnedNotes] Relay returned ${pinListResult.ids.length} pinned IDs`)
      persistPendingRef.current = true
      setPinnedIds(pinListResult.ids)
    } else if (pinListResult.status === 'none' || pinListResult.status === 'no-list') {
      setPinnedIds(prev => {
        if (prev.length === 0) return prev
        persistPendingRef.current = true
        return []
      })
    }
  }, [pinListResult])

  const pinnedNotesStatus: 'loading' | 'found' | 'none' | 'no-list' = isLoadingPinList ? 'loading' : (pinListResult?.status ?? 'no-list')

  // Fetch actual pinned note events
  const { data: pinnedNoteEvents, isLoading: isLoadingPinnedEvents } = useQuery({
    queryKey: ['pinned-note-events', pinnedIds],
    queryFn: async () => {
      if (pinnedIds.length === 0) return []

      const userRelays = getUserRelays()
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS
      const foundNotes: NostrEvent[] = []

      // Batch query all write relays
      for (const relayUrl of writeRelays) {
        try {
          const relay = nostr.relay(relayUrl)
          const missingIds = pinnedIds.filter(id => !foundNotes.some(n => n.id === id))
          if (missingIds.length === 0) break
          const events = await relay.query(
            [{ ids: missingIds }],
            { signal: AbortSignal.timeout(3000) }
          )
          for (const ev of events) {
            if (!foundNotes.some(n => n.id === ev.id)) {
              foundNotes.push(ev)
            }
          }
        } catch {
          // Try next relay
        }
      }

      // Return in pinned order
      return pinnedIds
        .map(id => foundNotes.find(n => n.id === id))
        .filter((n): n is NostrEvent => !!n)
    },
    enabled: pinnedIds.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])

  // Publish updated kind 10001 pin list directly to each relay.
  // Uses fresh NRelay1 connections instead of the NPool to avoid stale
  // WebSocket issues after idle periods that caused unpins to be lost.
  const publishPinList = useCallback(async (newIds: string[]) => {
    if (!user) return

    const tags = newIds.map(id => ['e', id])
    const event = await user.signer.signEvent({
      kind: 10001,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })

    const userRelays = getUserRelays()
    const relays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS
    let published = 0
    await Promise.allSettled(
      relays.map(async (url) => {
        const relay = new NRelay1(normalizeRelay(url), { backoff: false })
        try {
          await relay.event(event, { signal: AbortSignal.timeout(8000) })
          published++
        } catch (err) {
          console.warn(`[pinnedNotes] ${url} rejected:`, err)
        } finally {
          try { relay.close() } catch { /* */ }
        }
      })
    )
    if (published === 0) {
      console.error('[pinnedNotes] No relays accepted the pin list update')
    } else {
      console.log(`[pinnedNotes] Pin list published to ${published}/${relays.length} relays`)
    }
  }, [user])

  // Toggle pin: add or remove, publish, update local + set optimistic cache.
  // We use setQueryData (not invalidateQueries) for the pin list to prevent
  // stale relay data from overwriting the optimistic state. We also pre-seed
  // the pinned-note-events cache so the me tab doesn't flash.
  const togglePin = useCallback(async (noteId: string) => {
    if (!user) return

    const currentIds = [...pinnedIds]
    const isUnpin = currentIds.includes(noteId)
    const newIds = isUnpin
      ? currentIds.filter(id => id !== noteId)
      : [...currentIds, noteId]

    // Pre-seed pinned events cache for the new key so the me tab doesn't flash
    const oldEvents = queryClient.getQueryData<NostrEvent[]>(['pinned-note-events', currentIds]) ?? []
    if (isUnpin) {
      queryClient.setQueryData(['pinned-note-events', newIds], oldEvents.filter(e => e.id !== noteId))
    } else {
      // Carry forward existing events; newly pinned note will be fetched after publish
      queryClient.setQueryData(['pinned-note-events', newIds], oldEvents)
    }

    // Optimistic update
    persistPendingRef.current = true
    setPinnedIds(newIds)

    // Set optimistic pin list cache (prevents relay refetch from reverting)
    queryClient.setQueryData(['pinned-notes', user.pubkey],
      { ids: newIds, status: newIds.length > 0 ? 'found' as const : 'none' as const })

    // Publish to relays
    await publishPinList(newIds)

    // After relay confirms, refetch events to pick up newly pinned notes
    queryClient.invalidateQueries({ queryKey: ['pinned-note-events'] })
  }, [user, pinnedIds, publishPinList, queryClient])

  return {
    pinnedIds,
    pinnedSet,
    pinnedNotes: pinnedNoteEvents ?? [],
    pinnedNotesStatus,
    isLoading: isLoadingPinList || isLoadingPinnedEvents,
    isPinned: useCallback((noteId: string) => pinnedSet.has(noteId), [pinnedSet]),
    togglePin,
  }
}
