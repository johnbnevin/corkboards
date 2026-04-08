import { useState, useEffect, useCallback, useRef } from 'react'
import { type NostrEvent } from '@nostrify/nostrify'
import { useNostr } from '@/hooks/useNostr'
import { useCurrentUser } from '@/hooks/useCurrentUser'

interface DiscoverState {
  notes: NostrEvent[]
  /** All ranked notes before the per-author cap — used for "load more" */
  allRanked: NostrEvent[]
  isLoading: boolean
  lastUpdated: number | null
  engagementMap: Map<string, { type: 'reply' | 'repost' | 'quote'; by: string }[]>
  /** How many notes are currently shown (for load-more pagination) */
  shownCount: number
}

// Cache discovered notes in memory
const discoverCache: Map<string, DiscoverState> = new Map()

export function useDiscover(follows: string[] | undefined, enabled: boolean = true) {
  const { user } = useCurrentUser()
  const { nostr } = useNostr()
  const [state, setState] = useState<DiscoverState>({
    notes: [],
    allRanked: [],
    isLoading: false,
    lastUpdated: null,
    engagementMap: new Map(),
    shownCount: 100,
  })
  const isRunningRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Check if we should run discovery
  const shouldRun = enabled && user?.pubkey && follows && follows.length > 0

  const runDiscovery = useCallback(async () => {
    if (!shouldRun || !follows || isRunningRef.current) return

    // Check cache first (valid for 5 minutes)
    const cacheKey = user!.pubkey
    const cached = discoverCache.get(cacheKey)
    if (cached && cached.lastUpdated && Date.now() - cached.lastUpdated < 5 * 60 * 1000) {
      setState(cached)
      return
    }

    isRunningRef.current = true
    setState(prev => ({ ...prev, isLoading: true }))

    // Create abort controller for this run
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    try {
      const followSet = new Set(follows)
      const userPubkey = user!.pubkey

      const engagementMap = new Map<string, { type: 'reply' | 'repost' | 'quote'; by: string }[]>()
      const originalNoteIds = new Set<string>()
      const seenNotes = new Map<string, NostrEvent>()

      // Helper to process engagement events (filter out user's own engagements)
      const processEngagement = (event: NostrEvent) => {
        // Skip if this engagement is from the user
        if (event.pubkey === userPubkey) return

        const eTags = event.tags.filter(t => t[0] === 'e')
        const qTags = event.tags.filter(t => t[0] === 'q')

        // Check for quotes
        for (const qTag of qTags) {
          const quotedId = qTag[1]
          if (quotedId) {
            originalNoteIds.add(quotedId)
            const existing = engagementMap.get(quotedId) || []
            existing.push({ type: 'quote', by: event.pubkey })
            engagementMap.set(quotedId, existing)
          }
        }

        // Check for replies
        if (eTags.length > 0) {
          const replyTag = eTags.find(t => t[3] === 'reply') || eTags[eTags.length - 1]
          const parentId = replyTag[1]
          if (parentId) {
            originalNoteIds.add(parentId)
            const existing = engagementMap.get(parentId) || []
            existing.push({ type: 'reply', by: event.pubkey })
            engagementMap.set(parentId, existing)
          }
        }
      }

      const processRepost = (event: NostrEvent) => {
        // Skip if this repost is from the user
        if (event.pubkey === userPubkey) return

        const eTag = event.tags.find(t => t[0] === 'e')
        if (eTag?.[1]) {
          const repostedId = eTag[1]
          originalNoteIds.add(repostedId)
          const existing = engagementMap.get(repostedId) || []
          existing.push({ type: 'repost', by: event.pubkey })
          engagementMap.set(repostedId, existing)
        }
      }

      // Helper to update state with current notes
      const updateState = (notes: NostrEvent[], loading: boolean) => {
        const ranked = notes
          .filter(note => note.pubkey !== userPubkey) // Filter out user's own notes
          .filter(note => !followSet.has(note.pubkey))
          .filter(note => note.kind === 1 || note.kind === 30023)
          .sort((a, b) => {
            const aEngagements = engagementMap.get(a.id)?.length || 0
            const bEngagements = engagementMap.get(b.id)?.length || 0
            if (bEngagements !== aEngagements) return bEngagements - aEngagements
            return b.created_at - a.created_at
          })

        // 1 note per author — each person gets one best note
        const authorSeen = new Set<string>()
        const onePerAuthor: NostrEvent[] = []
        for (const note of ranked) {
          if (!authorSeen.has(note.pubkey)) {
            onePerAuthor.push(note)
            authorSeen.add(note.pubkey)
          }
        }

        setState(prev => ({
          notes: onePerAuthor.slice(0, prev.shownCount),
          allRanked: onePerAuthor,
          isLoading: loading,
          lastUpdated: loading ? null : Date.now(),
          engagementMap,
          shownCount: prev.shownCount,
        }))
      }

      // PHASE 1: Quick first batch - get something on screen fast
      // Use just first 30 friends, short timeout
      const quickFriends = follows.slice(0, 30)

      // Single query for both kinds [1] and [6] to reduce relay round-trips
      const quickEngagements = await nostr.query([{
        kinds: [1, 6],
        authors: quickFriends,
        limit: 75
      }], { signal: AbortSignal.timeout(2000) }).catch((): NostrEvent[] => [])

      if (signal.aborted) return

      // Process quick results - split by kind
      const quickReplies = quickEngagements.filter(e => e.kind === 1)
      const quickReposts = quickEngagements.filter(e => e.kind === 6)
      quickReplies.forEach(processEngagement)
      quickReposts.forEach(processRepost)

      // Fetch first batch of original notes
      const quickNoteIds = Array.from(originalNoteIds).slice(0, 20)
      if (quickNoteIds.length > 0) {
        const quickNotes = await nostr.query([{ ids: quickNoteIds }], {
          signal: AbortSignal.timeout(2000)
        }).catch((): NostrEvent[] => [])

        quickNotes.forEach(note => seenNotes.set(note.id, note))

        // Show initial results immediately
        if (seenNotes.size > 0) {
          updateState(Array.from(seenNotes.values()), true)
        }
      }

      if (signal.aborted) return

      // PHASE 2: Load more in background - parallel batches
      const remainingFriends = follows.slice(30, 200)
      if (remainingFriends.length > 0) {
        // Process remaining friends in parallel batches
        const batchSize = 50
        const batches: string[][] = []
        for (let i = 0; i < remainingFriends.length; i += batchSize) {
          batches.push(remainingFriends.slice(i, i + batchSize))
        }

        // Run all batches in parallel
        const batchPromises = batches.map(async (batch) => {
          // Single query for both kinds to halve relay round-trips per batch
          const engagements = await nostr.query([{
            kinds: [1, 6],
            authors: batch,
            limit: 150
          }], { signal: AbortSignal.timeout(4000) }).catch((): NostrEvent[] => [])
          return {
            replies: engagements.filter(e => e.kind === 1),
            reposts: engagements.filter(e => e.kind === 6),
          }
        })

        const batchResults = await Promise.all(batchPromises)

        if (signal.aborted) return

        // Process all batch results
        for (const { replies, reposts } of batchResults) {
          replies.forEach(processEngagement)
          reposts.forEach(processRepost)
        }

        // Fetch remaining original notes in parallel batches
        const allNoteIds = Array.from(originalNoteIds)
          .filter(id => !seenNotes.has(id))
          .slice(0, 150)

        if (allNoteIds.length > 0) {
          const noteBatches: string[][] = []
          for (let i = 0; i < allNoteIds.length; i += 50) {
            noteBatches.push(allNoteIds.slice(i, i + 50))
          }

          const notePromises = noteBatches.map(batch =>
            nostr.query([{ ids: batch }], {
              signal: AbortSignal.timeout(4000)
            }).catch((): NostrEvent[] => [])
          )

          const noteResults = await Promise.all(notePromises)

          if (signal.aborted) return

          for (const notes of noteResults) {
            notes.forEach(note => seenNotes.set(note.id, note))
          }
        }
      }

      if (signal.aborted) return

      // Final update
      const finalNotes = Array.from(seenNotes.values())
      updateState(finalNotes, false)

      // Update cache — store current state for fast reload
      setState(prev => {
        discoverCache.set(cacheKey, { ...prev, isLoading: false, lastUpdated: Date.now() })
        return prev
      })

    } catch (err) {
      console.error('Discovery error:', err)
      setState(prev => ({ ...prev, isLoading: false }))
    } finally {
      isRunningRef.current = false
    }
  }, [shouldRun, follows, user, nostr])

  // Run discovery when enabled - no delay
  useEffect(() => {
    if (!shouldRun) return

    // Small delay to let initial render complete, but not 5 seconds
    const timer = setTimeout(() => {
      runDiscovery()
    }, 500)

    return () => {
      clearTimeout(timer)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [shouldRun, runDiscovery])

  // Refresh function for manual refresh
  const refresh = useCallback(() => {
    if (user?.pubkey) {
      discoverCache.delete(user.pubkey)
    }
    setState(prev => ({ ...prev, shownCount: 100 }))
    runDiscovery()
  }, [user?.pubkey, runDiscovery])

  // Load more — show next 100 notes from the ranked pool
  const loadMore = useCallback(() => {
    setState(prev => {
      const newCount = prev.shownCount + 100
      return {
        ...prev,
        shownCount: newCount,
        notes: prev.allRanked.slice(0, newCount),
      }
    })
  }, [])

  const hasMoreDiscover = state.allRanked.length > state.notes.length

  return {
    discoveredNotes: state.notes,
    isLoading: state.isLoading,
    lastUpdated: state.lastUpdated,
    engagementMap: state.engagementMap,
    refresh,
    loadMore,
    hasMoreDiscover,
    totalDiscoverCount: state.allRanked.length,
  }
}
