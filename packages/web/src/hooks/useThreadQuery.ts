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
import { NKinds, type NostrEvent } from '@nostrify/nostrify'
import {
  parseThreadTags,
  buildThreadTree,
  flattenTree,
  deduplicateEvents,
  getParentId,
  type ThreadNode,
  type FlatThreadRow,
} from '@core/threadTree'
import { fetchEventWithOutbox, setCachedEvent, getCachedEvent } from '@/lib/fetchEvent'

const THREAD_STALE_TIME = 2 * 60 * 1000 // 2 minutes
const THREAD_GC_TIME = 10 * 60 * 1000   // 10 minutes

// Max levels to walk up when reconstructing the ancestor chain above the target.
// Bounds sequential fetches on pathological threads; real threads rarely nest
// this deep.
const MAX_ANCESTOR_HOPS = 24

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
  /** Loading state (no data yet) */
  isLoading: boolean
  /** A refetch is in flight while existing data stays on screen */
  isFetching: boolean
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

  // Derive root ID from target event's thread tags. Fall back to the immediate
  // reply parent (not just self) when a note carries only a `reply` marker and
  // no `root` marker — otherwise the thread would root at the reply itself and
  // never show the note being replied to.
  const rootId = useMemo(() => {
    if (!targetEvent) return null
    const tags = parseThreadTags(targetEvent)
    return tags.root || tags.reply || targetEvent.id
  }, [targetEvent])

  // Reconstruct the ancestor chain above the target by walking parent refs
  // upward and fetching each one. Without this, opening a deep reply shows only
  // that reply (and its descendants) because the intermediate ancestors were
  // never fetched — the reported "thread only shows the reply, not the note it
  // replied to" bug. Runs in the background; the UI renders the target-rooted
  // tree first, then re-roots higher as ancestors arrive.
  const { data: ancestorEvents } = useQuery({
    queryKey: ['thread-ancestors', targetEvent?.id],
    queryFn: async () => {
      if (!targetEvent) return [] as NostrEvent[]
      const chain: NostrEvent[] = []
      const seen = new Set<string>([targetEvent.id])
      let current = targetEvent
      for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
        const parentId = getParentId(current)
        if (!parentId || seen.has(parentId)) break
        seen.add(parentId)
        const parent = getCachedEvent(parentId)
          ?? await fetchEventWithOutbox(parentId, nostr).catch(() => null)
        if (!parent) break
        setCachedEvent(parent.id, parent)
        chain.push(parent)
        current = parent
      }
      return chain
    },
    enabled: !!targetEvent,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 1,
  })

  // The best available root: the topmost ancestor we actually fetched (walking
  // stopped either at the true root or where discovery failed), else the
  // tag-derived rootId.
  const effectiveRootId = useMemo(() => {
    if (ancestorEvents && ancestorEvents.length > 0) {
      return ancestorEvents[ancestorEvents.length - 1].id
    }
    return rootId
  }, [ancestorEvents, rootId])

  // (M2) When the thread root is an ADDRESSABLE event (e.g. long-form kind 30023),
  // replies reference it by its `a`-coordinate (kind:pubkey:d), not by an `e`-tag.
  // Derive that coordinate so we can ALSO query by `#a` and surface NIP-22 (kind
  // 1111) + kind-1 replies that would otherwise be invisible to the `#e` query.
  const rootAddr = useMemo(() => {
    if (!targetEvent || !NKinds.addressable(targetEvent.kind)) return null
    // Only the target event itself is addressable-resolvable here; a non-self
    // root would be a plain event id, handled by the existing #e path.
    if (rootId !== targetEvent.id) return null
    const d = targetEvent.tags.find(t => t[0] === 'd')?.[1] ?? ''
    return `${targetEvent.kind}:${targetEvent.pubkey}:${d}`
  }, [targetEvent, rootId])

  // Query 2 (pass 1): Fetch the thread by reference.
  // This #e-tag query has no `authors`, so the pool routes it via the wide-net
  // "reference" tier (user read relays + fallbacks). It catches replies that
  // were broadcast to common relays and renders immediately.
  const { data: threadEvents, isLoading: isLoadingThread, isFetching: isFetchingThread, error: threadError } = useQuery({
    queryKey: ['thread-tree', rootId, rootAddr],
    queryFn: async () => {
      if (!rootId) return []

      const idsToQuery = rootId === eventId ? [rootId] : [rootId, eventId!]
      // (M2) For addressable roots, ALSO query by `#a` coordinate and include
      // kind 1111 (NIP-22) so replies to the long-form root are not invisible.
      const filters = rootAddr
        ? [
            { kinds: [1, 7], '#e': idsToQuery, limit: 500 },
            { kinds: [1, 1111], '#a': [rootAddr], limit: 500 },
          ]
        : [{ kinds: [1, 7], '#e': idsToQuery, limit: 500 }]
      const events = await nostr.query(
        filters,
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

      // Merge with what this key already held: a refetch that happens to reach
      // fewer relays than the last one must never LOSE replies (the "refresh
      // took away the comments" bug — refresh means find what's missing).
      const prev = queryClient.getQueryData<NostrEvent[]>(['thread-tree', rootId, rootAddr]) ?? []
      return deduplicateEvents([...prev, ...events])
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
    queryKey: ['thread-outbox', rootId, rootAddr, participantAuthors],
    queryFn: async () => {
      if (!rootId || participantAuthors.length === 0) return []
      const idsToQuery = rootId === eventId ? [rootId] : [rootId, eventId!]
      const chunks: string[][] = []
      for (let i = 0; i < participantAuthors.length; i += OUTBOX_AUTHOR_CHUNK) {
        chunks.push(participantAuthors.slice(i, i + OUTBOX_AUTHOR_CHUNK))
      }
      const results = await Promise.all(
        chunks.map(chunk => {
          // (M2) Route addressable-root replies (#a + kind 1111) through the
          // per-author outbox tier too, so author-only replies are discovered.
          const filters = rootAddr
            ? [
                { kinds: [1, 7], '#e': idsToQuery, authors: chunk, limit: 500 },
                { kinds: [1, 1111], '#a': [rootAddr], authors: chunk, limit: 500 },
              ]
            : [{ kinds: [1, 7], '#e': idsToQuery, authors: chunk, limit: 500 }]
          return nostr.query(
            filters,
            { signal: AbortSignal.timeout(6000) },
          ).catch(() => [] as NostrEvent[])
        }),
      )
      // Same additive-merge as the tree pass — a weaker refetch never loses replies.
      const prev = queryClient.getQueryData<NostrEvent[]>(['thread-outbox', rootId, rootAddr, participantAuthors]) ?? []
      return deduplicateEvents([...prev, ...results.flat()])
    },
    enabled: !!rootId && !!targetEvent && participantAuthors.length > 0,
    staleTime: THREAD_STALE_TIME,
    gcTime: THREAD_GC_TIME,
    retry: 2,
  })

  const allEvents = useMemo(
    () => deduplicateEvents([
      ...(threadEvents ?? []),
      ...(outboxEvents ?? []),
      ...(ancestorEvents ?? []),
    ]),
    [threadEvents, outboxEvents, ancestorEvents],
  )

  // Build tree from flat events. Try the true (highest) root first, then the
  // tag root, then the target itself — so we never show a blank modal when we
  // do have the target event, and we show as much ancestry as we've fetched.
  const tree = useMemo(() => {
    if (allEvents.length === 0) return null
    const candidates = [effectiveRootId, rootId, targetEvent?.id]
    const tried = new Set<string>()
    for (const candidate of candidates) {
      if (!candidate || tried.has(candidate)) continue
      tried.add(candidate)
      const t = buildThreadTree(allEvents, candidate, injectedReply)
      if (t) return t
    }
    return null
  }, [effectiveRootId, rootId, targetEvent?.id, allEvents, injectedReply])

  // Flatten for virtualized rendering
  const rows = useMemo(() => {
    if (!tree || !eventId) return []
    return flattenTree(tree, eventId, collapsedIds)
  }, [tree, eventId, collapsedIds])

  const refetch = useCallback(() => {
    // ADDITIVE refresh: keep every comment already on screen and go looking
    // for ones we don't have. This used to resetQueries (clear-then-refetch),
    // which blanked the modal and — whenever a flaky relay answered with less
    // than before — permanently dropped comments the user was reading; it also
    // nulled injectedReply, vanishing the user's own just-posted reply. The
    // tree/outbox queryFns merge with the previous cache entry, so an
    // invalidation can only ever add events.
    if (eventId) {
      queryClient.invalidateQueries({ queryKey: ['thread-target', eventId] })
      queryClient.invalidateQueries({ queryKey: ['thread-ancestors', eventId] })
    }
    if (rootId) {
      queryClient.invalidateQueries({ queryKey: ['thread-tree', rootId] })
      queryClient.invalidateQueries({ queryKey: ['thread-outbox', rootId] })
    }
  }, [eventId, rootId, queryClient])

  const injectReply = useCallback((event: NostrEvent) => {
    setInjectedReply(event)
    setCachedEvent(event.id, event)
    // Also merge into the TanStack Query cache so the reply persists
    // when the user navigates away and back (injectedReply state is cleared
    // on navigation but query cache survives until staleTime expires).
    if (rootId) {
      // The key MUST match the live query's key exactly — ['thread-tree',
      // rootId, rootAddr]. Writing the two-element ['thread-tree', rootId]
      // created a SEPARATE cache entry that nothing ever read: the reply
      // survived in state only until navigation cleared `injectedReply`, and
      // then vanished on return, which is precisely the persistence this block
      // exists to provide. setQueryData does no key-prefix matching. (L15)
      queryClient.setQueryData<NostrEvent[]>(
        ['thread-tree', rootId, rootAddr],
        // Dedup by id — a double-submit or a concurrent refetch can inject the
        // same reply twice, bloating the cache and miscounting allEvents.
        (old) => old?.some(e => e.id === event.id) ? old : [...(old ?? []), event],
      )
    }
  }, [rootId, rootAddr, queryClient])

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
    isFetching: isFetchingThread,
    error,
    refetch,
    injectReply,
    collapsedIds,
    toggleCollapse,
  }
}
