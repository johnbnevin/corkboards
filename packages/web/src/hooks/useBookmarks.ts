/**
 * useBookmarks — NIP-51 kind 10003 private bookmark management.
 *
 * - Reads the user's kind 10003 bookmark list from relays
 * - Stores bookmark IDs as encrypted private tags in the content field
 * - Publishes updated kind 10003 events on add/remove
 * - Caches bookmark IDs in IDB for instant startup
 * - Designed to work alongside useCollapsedNotes for backward compatibility
 */

import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useNostr } from '@nostrify/react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { debugLog, debugWarn, debugError } from '@/lib/debug'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { idbGetSync, idbSetSync } from '@/lib/idb'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import type { NostrEvent } from '@nostrify/nostrify'

const IDB_KEY = 'nostr-bookmark-ids'

/** Read the public-bookmarks preference from IDB (default: false = private) */
function getPublicBookmarksPref(): boolean {
  try {
    return idbGetSync(STORAGE_KEYS.PUBLIC_BOOKMARKS) === 'true'
  } catch { return false }
}

/** Encrypt a string to self using NIP-44 */
async function encryptToSelf(signer: { nip44?: { encrypt(pk: string, msg: string): Promise<string> } }, pubkey: string, plaintext: string): Promise<string> {
  if (signer.nip44) return signer.nip44.encrypt(pubkey, plaintext)
  throw new Error('Signer does not support NIP-44 encryption')
}

/** Decrypt a string from self using NIP-44 */
async function decryptFromSelf(signer: { nip44?: { decrypt(pk: string, msg: string): Promise<string> } }, pubkey: string, ciphertext: string): Promise<string> {
  if (signer.nip44) {
    return signer.nip44.decrypt(pubkey, ciphertext)
  }
  throw new Error('Signer does not support NIP-44 decryption')
}

export function useBookmarks(fetchEnabled = true) {
  const { user } = useCurrentUser(false)
  const { nostr } = useNostr()
  const queryClient = useQueryClient()
  const publishingRef = useRef(false)
  // Ref to avoid stale closure when setTimeout fires after user changes
  const userRef = useRef(user)
  userRef.current = user

  // Local bookmark IDs for instant UI (synced from relay + IDB cache)
  const [bookmarkIds, setBookmarkIds] = useState<string[]>(() => {
    try {
      const stored = idbGetSync(IDB_KEY)
      const parsed = stored ? JSON.parse(stored) : []
      debugLog('[bookmarks] IDB cache:', parsed.length, 'ids')
      return parsed
    } catch {
      return []
    }
  })

  // Track whether we've done the initial migration from collapsed-notes (persisted in IDB)
  const hasMigrated = useRef(() => {
    try { return idbGetSync('nostr-bookmarks-migrated') === 'true' } catch { return false }
  })
  // Track mount state to avoid setState/publish after unmount
  const isMountedRef = useRef(true)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    return () => {
      isMountedRef.current = false
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
  }, [])

  // Listen for external writes to bookmark IDs (e.g. restoreFromBackupFile, cross-tab sync).
  // Also re-reads after idbReady to pick up data from IDB when memCache was empty on mount.
  useEffect(() => {
    const mergeFromIdb = () => {
      try {
        const stored = idbGetSync(IDB_KEY)
        if (!stored) return
        const ids: string[] = JSON.parse(stored)
        if (ids.length > 0) {
          setBookmarkIds(prev => {
            const merged = [...new Set([...ids, ...prev])]
            if (merged.length === prev.length && merged.every(id => prev.includes(id))) return prev
            persistPendingRef.current = true
            return merged
          })
        }
      } catch { /* ignore */ }
    }

    // Sync event from idbSetSync (fired by restoreFromBackupFile and cross-tab writes)
    const handleSync = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string }>).detail
      if (detail.key === IDB_KEY) mergeFromIdb()
    }
    window.addEventListener('idb-storage-sync', handleSync)

    // Also re-read after IDB warms up (memCache may have been empty on mount)
    let cancelled = false
    import('@/lib/idb').then(({ idbReady }) => idbReady).then(() => {
      if (!cancelled) mergeFromIdb()
    })

    return () => {
      cancelled = true
      window.removeEventListener('idb-storage-sync', handleSync)
    }
  }, [])

  // Persist to IDB — but ONLY when triggered by explicit user action (add/remove/toggle).
  // Never persist the initial [] or relay-synced state, which could overwrite restored data.
  const persistPendingRef = useRef(false)
  useEffect(() => {
    if (!persistPendingRef.current) return
    persistPendingRef.current = false
    try {
      idbSetSync(IDB_KEY, JSON.stringify(bookmarkIds))
    } catch (e) {
      if (import.meta.env.DEV) console.error('[bookmarks] Failed to save to IDB:', e)
    }
  }, [bookmarkIds])

  // Fetch bookmark list (kind 10003) from relays
  const { data: relayResult, isLoading } = useQuery({
    queryKey: ['bookmarks', user?.pubkey],
    queryFn: async (): Promise<{ ids: string[]; found: boolean; hasPublicTags: boolean }> => {
      if (!user?.pubkey) return { ids: [], found: false, hasPublicTags: false }

      const userRelays = getUserRelays()
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS
      debugLog('[bookmarks] Querying relays for kind 10003:', writeRelays)

      let bookmarkEvent: NostrEvent | null = null
      try {
        bookmarkEvent = await Promise.any(
          writeRelays.map(async (relayUrl) => {
            const relay = nostr.relay(relayUrl)
            const [ev] = await relay.query(
              [{ kinds: [10003], authors: [user.pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(5000) },
            )
            if (!ev) throw new Error('no bookmark list')
            debugLog('[bookmarks] Found kind 10003 on', relayUrl, '—', ev.tags.length, 'public tags, content:', ev.content ? ev.content.length + ' chars' : 'empty')
            return ev
          }),
        )
      } catch {
        debugLog('[bookmarks] No kind 10003 found on any relay')
        return { ids: [], found: false, hasPublicTags: false }
      }

      if (!bookmarkEvent) return { ids: [], found: false, hasPublicTags: false }

      // Public tags (from other clients or legacy)
      const publicIds = bookmarkEvent.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1])

      // Private tags (encrypted in content)
      let privateIds: string[] = []
      if (bookmarkEvent.content) {
        try {
          debugLog('[bookmarks] Decrypting private bookmark content...')
          const decrypted = await decryptFromSelf(user.signer, user.pubkey, bookmarkEvent.content)
          const tags = JSON.parse(decrypted) as string[][]
          privateIds = tags.filter(t => t[0] === 'e' && t[1]).map(t => t[1])
          debugLog('[bookmarks] Decrypted', privateIds.length, 'private bookmarks')
        } catch (err) {
          debugWarn('[bookmarks] Failed to decrypt content:', err)
        }
      }

      const ids = [...new Set([...publicIds, ...privateIds])]
      debugLog('[bookmarks] Total:', ids.length, 'bookmark ids (public:', publicIds.length, ', private:', privateIds.length, ')')
      return { ids, found: true, hasPublicTags: publicIds.length > 0 }
    },
    enabled: !!user?.pubkey && fetchEnabled,
    staleTime: 5 * 60_000,
  })

  // Publish updated kind 10003 bookmark list to relays
  const publishBookmarkList = useCallback(async (newIds: string[]) => {
    // Read user from ref to avoid stale closure in setTimeout callbacks
    const currentUser = userRef.current
    if (!currentUser) {
      debugWarn('[bookmarks] Publish skipped — no user')
      return
    }
    if (!currentUser.signer.nip44) {
      debugError('[bookmarks] Publish skipped — signer does not support NIP-44 encryption')
      return
    }
    if (publishingRef.current) {
      debugWarn('[bookmarks] Publish skipped — already publishing')
      return
    }
    publishingRef.current = true

    const isPublic = getPublicBookmarksPref()
    debugLog('[bookmarks] Publishing kind 10003 with', newIds.length, 'bookmarks (public:', isPublic, ')')

    try {
      const eTags = newIds.map(id => ['e', id])
      const payload = JSON.stringify(eTags)
      const encrypted = await encryptToSelf(currentUser.signer, currentUser.pubkey, payload)

      const event = await currentUser.signer.signEvent({
        kind: 10003,
        content: encrypted,
        tags: isPublic ? eTags : [],  // public tags only when user opts in
        created_at: Math.floor(Date.now() / 1000),
      })
      debugLog('[bookmarks] Signed event', event.id.slice(0, 8))
      await nostr.event(event, { signal: AbortSignal.timeout(8000) })
      debugLog('[bookmarks] Published successfully')
      // Invalidate query cache so UI sees fresh state
      queryClient.invalidateQueries({ queryKey: ['bookmarks', currentUser.pubkey] })
    } catch (err) {
      debugError('[bookmarks] Publish failed:', err)
    } finally {
      publishingRef.current = false
    }
  }, [nostr, queryClient])

  // Sync local state when relay data arrives, and handle migration
  useEffect(() => {
    if (!relayResult || !user?.pubkey) return

    debugLog('[bookmarks] Sync effect — relay found:', relayResult.found, 'ids:', relayResult.ids.length, 'hasPublicTags:', relayResult.hasPublicTags)

    if (relayResult.found && relayResult.ids.length > 0) {
      setBookmarkIds(prev => {
        const merged = [...new Set([...relayResult.ids, ...prev])]
        if (merged.length === prev.length && merged.every(id => prev.includes(id))) {
          debugLog('[bookmarks] Relay bookmarks already in local state')
          return prev
        }
        debugLog('[bookmarks] Merged relay bookmarks:', prev.length, '→', merged.length)
        persistPendingRef.current = true
        return merged
      })

      // Re-publish if public/private state doesn't match user preference
      if (relayResult.hasPublicTags && !getPublicBookmarksPref()) {
        debugLog('[bookmarks] Re-publishing bookmarks as private (user preference)...')
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
        syncTimerRef.current = setTimeout(() => { if (isMountedRef.current && userRef.current) publishBookmarkList(relayResult.ids) }, 3000)
      } else if (!relayResult.hasPublicTags && getPublicBookmarksPref()) {
        debugLog('[bookmarks] Re-publishing bookmarks as public (user preference)...')
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
        syncTimerRef.current = setTimeout(() => { if (isMountedRef.current && userRef.current) publishBookmarkList(relayResult.ids) }, 3000)
      }
    }

    // Migration: if relay has no bookmark IDs (empty or missing), check for legacy collapsed-notes
    if (relayResult.ids.length === 0 && !hasMigrated.current()) {
      hasMigrated.current = () => true
      try { idbSetSync('nostr-bookmarks-migrated', 'true') } catch { /* ignore */ }
      debugLog('[bookmarks] No relay bookmarks — checking for legacy collapsed-notes')
      try {
        const legacy = idbGetSync('collapsed-notes')
        if (legacy) {
          const legacyIds: string[] = JSON.parse(legacy)
          debugLog('[bookmarks] Found', legacyIds.length, 'legacy collapsed-notes to migrate')
          if (legacyIds.length > 0) {
            const idsToPublish = [...new Set(legacyIds)]
            persistPendingRef.current = true
            setBookmarkIds(idsToPublish)
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
            syncTimerRef.current = setTimeout(() => {
              if (isMountedRef.current && userRef.current) publishBookmarkList(idsToPublish)
            }, 2000)
          }
        } else {
          debugLog('[bookmarks] No legacy collapsed-notes found in IDB')
        }
      } catch (e) {
        debugError('[bookmarks] Migration error:', e)
      }
    }
  }, [relayResult, user?.pubkey, publishBookmarkList])

  const bookmarkSet = useMemo(() => new Set(bookmarkIds), [bookmarkIds])

  // Track pending publish — avoids side effects inside state setters
  const needsPublish = useRef(false)

  useEffect(() => {
    if (!needsPublish.current || bookmarkIds.length === 0) return
    needsPublish.current = false
    debugLog('[bookmarks] Scheduling publish for', bookmarkIds.length, 'bookmarks')
    if (publishTimer.current) clearTimeout(publishTimer.current)
    publishTimer.current = setTimeout(() => {
      publishBookmarkList(bookmarkIds)
    }, 1500)
  }, [bookmarkIds, publishBookmarkList])

  // Debounce publishing to batch rapid toggles
  const publishTimer = useRef<ReturnType<typeof setTimeout>>()

  // Clear any pending publish timer on unmount to prevent stale callbacks
  useEffect(() => {
    return () => {
      if (publishTimer.current) clearTimeout(publishTimer.current)
    }
  }, [])

  const addBookmark = useCallback((noteId: string) => {
    debugLog('[bookmarks] addBookmark:', noteId.slice(0, 8))
    persistPendingRef.current = true
    setBookmarkIds(prev => {
      if (prev.includes(noteId)) return prev
      needsPublish.current = true
      return [...prev, noteId]
    })
  }, [])

  const removeBookmark = useCallback((noteId: string) => {
    debugLog('[bookmarks] removeBookmark:', noteId.slice(0, 8))
    persistPendingRef.current = true
    setBookmarkIds(prev => {
      if (!prev.includes(noteId)) return prev
      needsPublish.current = true
      return prev.filter(id => id !== noteId)
    })
  }, [])

  const toggleBookmark = useCallback((noteId: string) => {
    if (bookmarkSet.has(noteId)) {
      removeBookmark(noteId)
    } else {
      addBookmark(noteId)
    }
  }, [bookmarkSet, addBookmark, removeBookmark])

  const isBookmarked = useCallback((noteId: string) => bookmarkSet.has(noteId), [bookmarkSet])

  /** Re-publish current bookmarks (e.g. after toggling public/private preference) */
  const republishBookmarks = useCallback(() => {
    if (bookmarkIds.length > 0) publishBookmarkList(bookmarkIds)
  }, [bookmarkIds, publishBookmarkList])

  return {
    bookmarkIds,
    bookmarkSet,
    isBookmarked,
    addBookmark,
    removeBookmark,
    toggleBookmark,
    republishBookmarks,
    isLoading,
  }
}
