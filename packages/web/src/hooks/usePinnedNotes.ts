import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from '@nostrify/react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getUserRelays, FALLBACK_RELAYS, createRelayFresh } from '@/components/NostrProvider'
import { idbSetSync } from '@/lib/idb'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import type { NostrEvent } from '@nostrify/nostrify'
import { normalizeRelay } from '@core/normalizeRelay'
import { debugLog, debugWarn, debugError } from '@/lib/debug'

const IDB_KEY = STORAGE_KEYS.PINNED_NOTE_IDS

/**
 * Result of reading the authoritative kind-10001.
 *
 * `status` is only ever 'none'/'no-list' when at least one relay actually
 * ANSWERED — see the queryFn. A total relay failure THROWS instead, because
 * "nobody answered" and "the user has no pins" are indistinguishable from an
 * empty result set, and treating the first as the second wipes the pin list.
 * `content` carries the NIP-51 encrypted private section forward verbatim.
 */
interface PinListResult {
  ids: string[]
  status: 'found' | 'none' | 'no-list'
  relayHints: Record<string, string>
  /** kind-10001 content — NIP-51 private (encrypted) pins. Preserved verbatim. */
  content: string
}

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
      debugError('[pinnedNotes] Failed to save to IDB:', e)
    }
  }, [pinnedIds])

  // Fetch pin list (kind 10001) from relays — query ALL write relays and
  // pick the newest event by created_at. Promise.any() previously raced
  // relays and could return stale data from a fast-but-outdated relay.
  const { data: pinListResult, isLoading: isLoadingPinList } = useQuery({
    queryKey: ['pinned-notes', user?.pubkey],
    queryFn: async (): Promise<PinListResult> => {
      if (!user?.pubkey) return { ids: [], status: 'no-list', relayHints: {}, content: '' }

      const userRelays = getUserRelays()
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS
      debugLog(`[pinnedNotes] Step 1: querying ${writeRelays.length} write relays for kind 10001 — pubkey=${user.pubkey.slice(0, 8)} relays=${writeRelays.join(', ')}`)

      // Query all write relays in parallel, collect all responses
      const results = await Promise.allSettled(
        writeRelays.map(async (relayUrl) => {
          const relay = createRelayFresh(normalizeRelay(relayUrl), { backoff: false })
          try {
            const events = await relay.query(
              [{ kinds: [10001], authors: [user.pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(8000) }
            )
            debugLog(`[pinnedNotes] ${relayUrl} → ${events.length} kind-10001 events`)
            return events.filter(ev => ev.kind === 10001)
          } catch (e) {
            debugWarn(`[pinnedNotes] ${relayUrl} failed:`, e)
            throw e
          } finally {
            try { relay.close() } catch { /* */ }
          }
        })
      )

      const fulfilled = results.filter(r => r.status === 'fulfilled').length
      const rejected = results.filter(r => r.status === 'rejected').length
      debugLog(`[pinnedNotes] Step 1 done: ${fulfilled} relays OK, ${rejected} relays failed`)

      // ZERO relays answered — we learned NOTHING about the user's pin list.
      // Reporting 'no-list' here (what this used to do) cleared the local pins
      // below and, worse, let the very next pin publish a ONE-ENTRY kind-10001
      // that replaced the user's real list on every relay. Kind 10001 is
      // replaceable; an empty base is a wipe. Throw instead: React Query retries,
      // `pinListResult` stays undefined, status stays 'loading', and
      // publishPinList refuses to build on an unconfirmed base. Mirrors the
      // confirmed-empty semantics of @core/contactList. (H1)
      if (fulfilled === 0) {
        throw new Error(`[pinnedNotes] All ${writeRelays.length} relays failed — pin list unconfirmed`)
      }

      // Pick the newest kind 10001 event across all relays
      let best: NostrEvent | null = null
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const ev of r.value) {
          if (!best || ev.created_at > best.created_at) best = ev
        }
      }

      if (!best) {
        // Confirmed-empty: at least one relay answered and had no kind-10001.
        debugLog('[pinnedNotes] Step 1 result: no kind 10001 found on any relay (confirmed)')
        return { ids: [], status: 'no-list', relayHints: {}, content: '' }
      }

      const eTags = best.tags.filter(t => t[0] === 'e' && t[1])
      const ids = eTags.map(t => t[1])
      // Extract per-note relay hints from the e-tags (["e", id, relay-hint])
      const relayHints: Record<string, string> = {}
      for (const t of eTags) {
        if (t[2]) relayHints[t[1]] = t[2]
      }

      debugLog(`[pinnedNotes] Step 1 result: ${ids.length} pinned IDs from event created_at=${best.created_at} hints=${Object.keys(relayHints).length}`)
      const content = best.content ?? ''
      if (ids.length === 0) return { ids: [], status: 'none', relayHints: {}, content }
      return { ids, status: 'found', relayHints, content }
    },
    enabled: !!user?.pubkey,
    staleTime: 5 * 60 * 1000,
    // Retry the total-failure throw above rather than surfacing an error state:
    // a transient outage must not look like "you have no pins".
    retry: 3,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15_000),
  })

  // Sync local state when relay data arrives — relay is authoritative over IDB cache.
  // If relay returns empty (no pins or no list), clear stale IDB data to prevent
  // contaminated cache from persisting across reloads.
  useEffect(() => {
    if (!pinListResult) return
    debugLog(`[pinnedNotes] pinListResult: status=${pinListResult.status} ids=${pinListResult.ids.length}`)
    if (pinListResult.ids.length > 0) {
      debugLog(`[pinnedNotes] Relay returned ${pinListResult.ids.length} pinned IDs`)
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

  // No result yet (still loading, or every retry failed) means UNCONFIRMED, not
  // "no list". Reporting 'no-list' for an unconfirmed read is what made the UI
  // show an empty me-tab and invited a clobbering republish. (H1)
  const pinnedNotesStatus: 'loading' | 'found' | 'none' | 'no-list' =
    isLoadingPinList || !pinListResult ? 'loading' : pinListResult.status

  // Fetch actual pinned note events — use NPool (outbox routing + fallback relays
  // in parallel) instead of querying only the user's write relays sequentially.
  // Notes pinned from other authors live on their relays, not the user's write relays.
  const { data: pinnedNoteEvents, isLoading: isLoadingPinnedEvents } = useQuery({
    queryKey: ['pinned-note-events', pinnedIds],
    queryFn: async () => {
      if (pinnedIds.length === 0) return []

      debugLog(`[pinnedNotes] Step 2: fetching ${pinnedIds.length} pinned note events — ids=${pinnedIds.map(id => id.slice(0, 8)).join(',')}`)
      const found = new Map<string, NostrEvent>()

      // Primary: NPool routes to outbox relays + fallbacks in parallel
      try {
        const events = await nostr.query(
          [{ ids: pinnedIds }],
          { signal: AbortSignal.timeout(10000) }
        )
        events.forEach(ev => found.set(ev.id, ev))
        debugLog(`[pinnedNotes] NPool returned ${events.length} events, ${pinnedIds.length - found.size} still missing`)
      } catch (e) {
        debugWarn('[pinnedNotes] NPool query failed:', e)
      }

      // Fallback 1: for notes still missing, try relay hints embedded in the pin list
      const missing = pinnedIds.filter(id => !found.has(id))
      if (missing.length > 0) {
        const cached = queryClient.getQueryData<{ relayHints: Record<string, string> }>(
          ['pinned-notes', user?.pubkey]
        )
        const hints = cached?.relayHints ?? {}
        const hinted = missing.filter(id => hints[id])
        debugLog(`[pinnedNotes] Fallback 1 (relay hints): ${missing.length} missing, ${hinted.length} have hints`)
        if (hinted.length > 0) {
          await Promise.allSettled(
            hinted.map(async id => {
              const relay = createRelayFresh(normalizeRelay(hints[id]), { backoff: false })
              try {
                const evs = await relay.query([{ ids: [id] }], { signal: AbortSignal.timeout(5000) })
                evs.forEach(ev => found.set(ev.id, ev))
              } catch (e) {
                debugWarn(`[pinnedNotes] Hint relay ${hints[id]} failed for ${id.slice(0, 8)}:`, e)
              }
              finally { try { relay.close() } catch { /* */ } }
            })
          )
          debugLog(`[pinnedNotes] After hint relays: found=${found.size}/${pinnedIds.length}`)
        }
      }

      // Fallback 2: still missing — query write relays directly (covers cold-cache desktop
      // sessions where the NPool hasn't routed to the right relays yet)
      const stillMissing = pinnedIds.filter(id => !found.has(id))
      if (stillMissing.length > 0) {
        const userRelays = getUserRelays()
        const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS
        debugLog(`[pinnedNotes] Fallback 2 (write relays): ${stillMissing.length} still missing, trying ${writeRelays.length} write relays`)
        for (const relayUrl of writeRelays) {
          const needIds = stillMissing.filter(id => !found.has(id))
          if (needIds.length === 0) break
          try {
            const relay = createRelayFresh(normalizeRelay(relayUrl), { backoff: false })
            try {
              const evs = await relay.query([{ ids: needIds }], { signal: AbortSignal.timeout(5000) })
              debugLog(`[pinnedNotes] ${relayUrl} returned ${evs.length} events for ${needIds.length} missing ids`)
              evs.forEach(ev => found.set(ev.id, ev))
            } finally {
              try { relay.close() } catch { /* */ }
            }
          } catch (e) {
            debugWarn(`[pinnedNotes] Write relay ${relayUrl} failed:`, e)
          }
        }
      }

      const final = pinnedIds.map(id => found.get(id)).filter((n): n is NostrEvent => !!n)
      debugLog(`[pinnedNotes] Step 2 done: ${final.length}/${pinnedIds.length} pinned notes resolved`)
      return final
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

    // REFUSE to publish from an unconfirmed base. kind 10001 is replaceable, so
    // the event we sign here REPLACES whatever the relays hold. Without a
    // confirmed read we don't know what we'd be replacing, and the failure mode
    // is silent and total (every pin gone). Same stance as @core/contactList's
    // "nothing confirmable — caller must abort rather than risk a wipe". (H1)
    if (!pinListResult) {
      throw new Error('Could not confirm your pin list; pin change aborted to avoid data loss')
    }

    const userRelays = getUserRelays()
    const relays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS
    debugLog(`[pinnedNotes] publishPinList: ${newIds.length} IDs → ${relays.length} write relays: ${relays.join(', ')}`)

    // Preserve each pin's relay hint (["e", id, relay-hint]). The read path
    // relies on these hints to locate notes pinned from other authors; rebuilding
    // bare ["e", id] tags on every pin/unpin would strip them all. (H3)
    const hints = pinListResult.relayHints
    const tags = newIds.map(id => (hints[id] ? ['e', id, hints[id]] : ['e', id]))
    const event = await user.signer.signEvent({
      kind: 10001,
      // Carry the existing content forward. NIP-51 stores PRIVATE list items as
      // a NIP-44 payload in `content`; writing '' here (what this used to do)
      // silently destroyed every privately-pinned note on the first public
      // pin/unpin. Mirrors useMuteList.ts's `content ?? muteEvent?.content`. (H1)
      content: pinListResult.content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })

    let published = 0
    await Promise.allSettled(
      relays.map(async (url) => {
        const relay = createRelayFresh(normalizeRelay(url), { backoff: false })
        try {
          await relay.event(event, { signal: AbortSignal.timeout(8000) })
          published++
          debugLog(`[pinnedNotes] ${url} accepted pin list`)
        } catch (err) {
          debugWarn(`[pinnedNotes] ${url} rejected:`, err)
        } finally {
          try { relay.close() } catch { /* */ }
        }
      })
    )
    if (published === 0) {
      debugError('[pinnedNotes] No relays accepted the pin list update')
    } else {
      debugLog(`[pinnedNotes] Pin list published to ${published}/${relays.length} relays`)
    }
  }, [user, pinListResult])

  // Toggle pin: add or remove, publish, update local + set optimistic cache.
  // We use setQueryData (not invalidateQueries) for the pin list to prevent
  // stale relay data from overwriting the optimistic state. We also pre-seed
  // the pinned-note-events cache so the me tab doesn't flash.
  const togglePin = useCallback(async (noteId: string) => {
    if (!user) return

    // Bail BEFORE the optimistic update when the list is unconfirmed, so the UI
    // never shows a pin state we can't actually persist. (H1)
    if (!pinListResult) {
      debugError('[pinnedNotes] togglePin refused — pin list not confirmed from any relay')
      throw new Error('Could not confirm your pin list; please try again')
    }

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

    // Set optimistic pin list cache (prevents relay refetch from reverting).
    // Carry relayHints forward: publishPinList reads them from this cache, so
    // dropping them here would strip every pin's relay hint on the NEXT pin/unpin.
    queryClient.setQueryData<PinListResult>(['pinned-notes', user.pubkey], {
      ids: newIds,
      status: newIds.length > 0 ? 'found' : 'none',
      relayHints: pinListResult.relayHints,
      // Keep the private section alive across optimistic updates too — the next
      // publish reads `content` from this cache entry.
      content: pinListResult.content,
    })

    // Publish to relays
    await publishPinList(newIds)

    // After relay confirms, refetch events to pick up newly pinned notes
    queryClient.invalidateQueries({ queryKey: ['pinned-note-events'] })
  }, [user, pinnedIds, publishPinList, queryClient, pinListResult])

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
