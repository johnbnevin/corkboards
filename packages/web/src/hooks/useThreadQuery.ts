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
import { fetchEventWithOutbox, setCachedEvent } from '@/lib/fetchEvent'

const THREAD_STALE_TIME = 2 * 60 * 1000 // 2 minutes
const THREAD_GC_TIME = 10 * 60 * 1000   // 10 minutes

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
      return fetchEventWithOutbox(eventId, nostr)
    },
    enabled: !!eventId,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 2,
    retryDelay: 1000,
  })

  // Derive root ID from target event's thread tags
  const rootId = useMemo(() => {
    if (!targetEvent) return null
    const tags = parseThreadTags(targetEvent)
    return tags.root || targetEvent.id
  }, [targetEvent])

  // Query 2: Fetch entire thread (all events referencing root)
  const { data: threadEvents, isLoading: isLoadingThread, error: threadError } = useQuery({
    queryKey: ['thread-tree', rootId],
    queryFn: async () => {
      if (!rootId) return []

      // Single bulk query — NPool's reqRouter handles relay routing
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
    retry: 1,
  })

  const allEvents = useMemo(() => threadEvents ?? [], [threadEvents])

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
    if (eventId) queryClient.invalidateQueries({ queryKey: ['thread-target', eventId] })
    if (rootId) queryClient.invalidateQueries({ queryKey: ['thread-tree', rootId] })
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
        (old) => old ? [...old, event] : [event],
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
