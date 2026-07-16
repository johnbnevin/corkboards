/**
 * useThreadQuery — TanStack Query-based thread fetching.
 *
 * Replaces the 968-line useThread.ts with ~200 lines by leveraging:
 * - NPool's built-in reqRouter for outbox routing (no manual relay management)
 * - TanStack Query for caching, retry, dedup, and lifecycle management
 * - Pure tree-building functions from @core/threadTree
 *
 * Two queries:
 * 1. Fetch target event by ID
 * 2. Fetch entire thread tree (all events referencing the root)
 */
import { useMemo, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNostr } from '@/hooks/useNostr'
import type { NostrEvent } from '@nostrify/nostrify'
import {
  parseThreadTags,
  buildThreadTree,
  flattenTree,
  deduplicateEvents,
  type ThreadNode,
  type FlatThreadRow,
} from '@core/threadTree'
import { fetchEventWithOutbox, setCachedEvent, getCachedEvent, clearEventCache } from '@/lib/fetchEvent'

const THREAD_STALE_TIME = 2 * 60 * 1000 // 2 minutes
const THREAD_GC_TIME = 10 * 60 * 1000   // 10 minutes

// Second-pass (author-outbox) discovery tuning.
// A cap on how many thread participants we re-query by outbox, and a chunk size
// kept *under* the pool's BULK_AUTHOR_THRESHOLD (10) so each chunk stays in the
// per-author outbox tier instead of collapsing to the narrow bulk tier.
const MAX_THREAD_AUTHORS = 48
const OUTBOX_AUTHOR_CHUNK = 8

export interface UseThreadQueryResult {
  /** The root ThreadNode tree */
  tree: ThreadNode | null
  /** Flattened rows for virtualized rendering */
  rows: FlatThreadRow[]
  /** The target event */
  targetEvent: NostrEvent | null
  /** The root event ID */
  rootId: string | null
  /** All raw events in the thread */
  allEvents: NostrEvent[]
  /** Loading state */
  isLoading: boolean
  /** Error message */
  error: string | null
  /** Refetch the thread */
  refetch: () => void
  /** Inject a just-posted reply without refetching */
  injectReply: (event: NostrEvent) => void
  /** Set of collapsed node IDs */
  collapsedIds: Set<string>
  /** Toggle collapse state */
  toggleCollapse: (eventId: string) => void
}

export function useThreadQuery(eventId: string | null): UseThreadQueryResult {
  const { nostr } = useNostr()
  const queryClient = useQueryClient()
  const [injectedReply, setInjectedReply] = useState<NostrEvent | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  // Reset state when eventId changes
  const [prevEventId, setPrevEventId] = useState(eventId)
  if (eventId !== prevEventId) {
    setPrevEventId(eventId)
    setInjectedReply(null)
    setCollapsedIds(new Set())
  }

  // Query 1: Fetch the target event
  const { data: targetEvent, isLoading: isLoadingTarget, error: targetError } = useQuery({
    queryKey: ['thread-target', eventId],
    queryFn: async () => {
      if (!eventId) return null
      // Instant hit if we already have the event cached (e.g. it was just
      // visible in the feed) — avoids a blank modal while relays respond.
      const cached = getCachedEvent(eventId)
      if (cached) return cached
      // Try NPool first (uses reqRouter with outbox routing), fall back to fetchEventWithOutbox
      const events = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      )
      if (events[0]) {
        setCachedEvent(events[0].id, events[0])
        return events[0]
      }
      // Fallback: direct relay queries with outbox discovery
      const viaOutbox = await fetchEventWithOutbox(eventId, nostr)
      if (viaOutbox) return viaOutbox
      // Not found on this attempt. THROW rather than returning null: a null
      // success gets cached and renders as a permanent "No thread data found"
      // with no retry. Throwing lets React Query retry (and keeps the skeleton
      // up), then surface a real error + "Try again" if it stays unreachable.
      throw new Error('Event not found')
    },
    enabled: !!eventId,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 3,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4000),
  })

  // Derive root ID from target event's thread tags
  const rootId = useMemo(() => {
    if (!targetEvent) return null
    const tags = parseThreadTags(targetEvent)
    return tags.root || targetEvent.id
  }, [targetEvent])

  // Query 2 (pass 1): Fetch the thread by reference.
  // This #e-tag query has no `authors`, so the pool routes it via the wide-net
  // "reference" tier (user read relays + fallbacks). It catches replies that
  // were broadcast to common relays and renders immediately.
  const { data: threadEvents, isLoading: isLoadingThread, error: threadError } = useQuery({
    queryKey: ['thread-tree', rootId],
    queryFn: async () => {
      if (!rootId) return []

      const idsToQuery = rootId === eventId ? [rootId] : [rootId, eventId!]
      const events = await nostr.query(
        [{ kinds: [1, 7], '#e': idsToQuery, limit: 500 }],
        { signal: AbortSignal.timeout(8000) },
      )

      // Also fetch the root event itself if not in results
      if (!events.some(e => e.id === rootId)) {
        const rootEvents = await nostr.query(
          [{ ids: [rootId], limit: 1 }],
          { signal: AbortSignal.timeout(3000) },
        ).catch(() => [] as NostrEvent[])
        events.push(...rootEvents)
      }

      // Include the target event if not in results
      if (targetEvent && !events.some(e => e.id === targetEvent.id)) {
        events.push(targetEvent)
      }

      return deduplicateEvents(events)
    },
    enabled: !!rootId && !!targetEvent,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 2,
  })

  // Participants discovered in pass 1 — the pubkeys we can now route by outbox.
  // Sorted for a stable query key so this doesn't refetch on every render.
  const participantAuthors = useMemo(() => {
    const set = new Set<string>()
    for (const e of threadEvents ?? []) set.add(e.pubkey)
    if (targetEvent) set.add(targetEvent.pubkey)
    return Array.from(set).sort().slice(0, MAX_THREAD_AUTHORS)
  }, [threadEvents, targetEvent])

  // Query 2 (pass 2): Author-outbox discovery.
  // An author-less #e query can't use the outbox model, so a reply written only
  // to its author's own relay is invisible to pass 1. Re-query the same thread
  // scoped to the participants we just found — adding `authors` lets the pool
  // route to each author's own relays. Chunked under BULK_AUTHOR_THRESHOLD so
  // each chunk stays in the per-author outbox tier. Runs after pass 1 so the UI
  // shows results first, then fills in.
  const { data: outboxEvents } = useQuery({
    queryKey: ['thread-outbox', rootId, participantAuthors],
    queryFn: async () => {
      if (!rootId || participantAuthors.length === 0) return []
      const idsToQuery = rootId === eventId ? [rootId] : [rootId, eventId!]
      const chunks: string[][] = []
      for (let i = 0; i < participantAuthors.length; i += OUTBOX_AUTHOR_CHUNK) {
        chunks.push(participantAuthors.slice(i, i + OUTBOX_AUTHOR_CHUNK))
      }
      const results = await Promise.all(
        chunks.map(chunk =>
          nostr.query(
            [{ kinds: [1, 7], '#e': idsToQuery, authors: chunk, limit: 500 }],
            { signal: AbortSignal.timeout(6000) },
          ).catch(() => [] as NostrEvent[]),
        ),
      )
      return results.flat()
    },
    enabled: !!rootId && !!targetEvent && participantAuthors.length > 0,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 2,
  })

  const allEvents = useMemo(
    () => deduplicateEvents([...(threadEvents ?? []), ...(outboxEvents ?? [])]),
    [threadEvents, outboxEvents],
  )

  // Build tree from flat events
  const tree = useMemo(() => {
    if (!rootId || allEvents.length === 0) return null
    return buildThreadTree(allEvents, rootId, injectedReply)
  }, [rootId, allEvents, injectedReply])

  // Flatten for virtualized rendering
  const rows = useMemo(() => {
    if (!tree || !eventId) return []
    return flattenTree(tree, eventId, collapsedIds)
  }, [tree, eventId, collapsedIds])

  const refetch = useCallback(() => {
    setInjectedReply(null)
    // A manual refresh should hit the network fresh, not re-serve a stale/partial
    // cached result — the user reaching for refresh means what they have is wrong.
    // Drop the cached target event so query 1 re-runs outbox discovery, and reset
    // (not just invalidate) the tree/outbox passes so they refetch from relays.
    if (eventId) {
      clearEventCache(eventId)
      queryClient.resetQueries({ queryKey: ['thread-target', eventId] })
    }
    if (rootId) {
      queryClient.resetQueries({ queryKey: ['thread-tree', rootId] })
      queryClient.resetQueries({ queryKey: ['thread-outbox', rootId] })
    }
  }, [eventId, rootId, queryClient])

  const injectReply = useCallback((event: NostrEvent) => {
    setInjectedReply(event)
    setCachedEvent(event.id, event)
    // Also merge into the TanStack Query cache so the reply persists
    // when the user navigates away and back (injectedReply state is cleared
    // on navigation but query cache survives until staleTime expires).
    if (rootId) {
      queryClient.setQueryData<NostrEvent[]>(
        ['thread-tree', rootId],
        // Dedup by id — a double-submit or a concurrent refetch can inject the
        // same reply twice, bloating the cache and miscounting allEvents.
        (old) => old?.some(e => e.id === event.id) ? old : [...(old ?? []), event],
      )
    }
  }, [rootId, queryClient])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isLoading = isLoadingTarget || isLoadingThread
  const error = targetError ? 'Failed to load event' : threadError ? 'Failed to load thread' : null

  return {
    tree,
    rows,
    targetEvent: targetEvent ?? null,
    rootId,
    allEvents,
    isLoading,
    error,
    refetch,
    injectReply,
    collapsedIds,
    toggleCollapse,
  }
}
