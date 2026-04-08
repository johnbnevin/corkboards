import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from '@nostrify/react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { idbSetSync } from '@/lib/idb'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import type { NostrEvent } from '@nostrify/nostrify'

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

  // Fetch pin list (kind 10001) from relays
  const { data: pinListResult, isLoading: isLoadingPinList } = useQuery({
    queryKey: ['pinned-notes', user?.pubkey],
    queryFn: async (): Promise<{ ids: string[]; status: 'found' | 'none' | 'no-list' }> => {
      if (!user?.pubkey) return { ids: [], status: 'no-list' }

      const userRelays = getUserRelays()
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS

      let pinList: NostrEvent | null = null
      try {
        pinList = await Promise.any(
          writeRelays.map(async (relayUrl) => {
            const relay = nostr.relay(relayUrl)
            const [ev] = await relay.query(
              [{ kinds: [10001], authors: [user.pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(3000) }
            )
            if (!ev) throw new Error('no pin list')
            return ev
          })
        )
      } catch {
        return { ids: [], status: 'no-list' }
      }

      if (!pinList) return { ids: [], status: 'no-list' }

      // Defensive: verify relay returned the correct kind (some relays may
      // return wrong-kind events, e.g. kind 10003 bookmarks instead of 10001)
      if (pinList.kind !== 10001) return { ids: [], status: 'no-list' }

      const ids = pinList.tags
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

  // Publish updated kind 10001 pin list to relays
  const publishPinList = useCallback(async (newIds: string[]) => {
    if (!user) return

    const tags = newIds.map(id => ['e', id])
    const event = await user.signer.signEvent({
      kind: 10001,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })

    try {
      await nostr.event(event, { signal: AbortSignal.timeout(8000) })
    } catch (err) {
      console.warn('[pinnedNotes] Some relays may have rejected:', err)
    }
  }, [user, nostr])

  // Toggle pin: add or remove, publish, update local + invalidate queries
  const togglePin = useCallback(async (noteId: string) => {
    if (!user) return

    const currentIds = [...pinnedIds]
    const newIds = currentIds.includes(noteId)
      ? currentIds.filter(id => id !== noteId)
      : [...currentIds, noteId]

    // Optimistic update
    persistPendingRef.current = true
    setPinnedIds(newIds)

    // Publish to relays
    await publishPinList(newIds)

    // Invalidate to refetch
    queryClient.invalidateQueries({ queryKey: ['pinned-notes', user.pubkey] })
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
