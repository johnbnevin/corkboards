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

/**
 * What we read off the user's kind-10003, including the parts this app doesn't
 * own.
 *
 * NIP-51 bookmark lists are a SHARED, multi-client structure: `e` (notes),
 * `a` (articles / addressable events), `t` (hashtags) and `r` (URLs), in a
 * public tag section and an encrypted private one. corkboards only manages
 * note bookmarks (`e`), but kind 10003 is REPLACEABLE — the event we publish
 * replaces the whole thing. Rebuilding it from our `e` tags alone silently
 * deleted every article, hashtag and link the user had bookmarked in any other
 * client, and every private tag we didn't happen to be tracking.
 *
 * So we keep the unrecognized tags — public and private — verbatim, and merge
 * them back on publish. (H2)
 */
interface BookmarkListResult {
  /** Note ids (`e` tags) from both sections — what this app manages. */
  ids: string[]
  /** True when a relay actually returned a kind-10003. */
  found: boolean
  /** True when note ids were present as PUBLIC tags. */
  hasPublicTags: boolean
  /** Every public tag that is not one of OUR `e` tags — other clients' data. */
  foreignPublicTags: string[][]
  /** Every decrypted private tag that is not an `e` tag — other clients' data. */
  foreignPrivateTags: string[][]
  /** True when `content` existed but could NOT be decrypted (see publish guard). */
  privateSectionUnreadable: boolean
  /** The raw encrypted `content`, so an unreadable private section can be re-sent as-is. */
  rawContent: string
}

const EMPTY_BOOKMARK_RESULT: BookmarkListResult = {
  ids: [], found: false, hasPublicTags: false,
  foreignPublicTags: [], foreignPrivateTags: [],
  privateSectionUnreadable: false, rawContent: '',
}

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
    queryFn: async (): Promise<BookmarkListResult> => {
      if (!user?.pubkey) return EMPTY_BOOKMARK_RESULT

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
        return EMPTY_BOOKMARK_RESULT
      }

      if (!bookmarkEvent) return EMPTY_BOOKMARK_RESULT

      // Public tags (from other clients or legacy)
      const publicIds = bookmarkEvent.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1])
      // Everything else the user (or another client) put in the public section:
      // `a` articles, `t` hashtags, `r` URLs, and anything a NIP we haven't read
      // yet defines. Carried through publish untouched.
      const foreignPublicTags = bookmarkEvent.tags.filter(t => !(t[0] === 'e' && t[1]))

      // Private tags (encrypted in content)
      let privateIds: string[] = []
      let foreignPrivateTags: string[][] = []
      let privateSectionUnreadable = false
      if (bookmarkEvent.content) {
        try {
          debugLog('[bookmarks] Decrypting private bookmark content...')
          const decrypted = await decryptFromSelf(user.signer, user.pubkey, bookmarkEvent.content)
          const tags = JSON.parse(decrypted) as string[][]
          privateIds = tags.filter(t => t[0] === 'e' && t[1]).map(t => t[1])
          foreignPrivateTags = tags.filter(t => !(t[0] === 'e' && t[1]))
          debugLog('[bookmarks] Decrypted', privateIds.length, 'private bookmarks,', foreignPrivateTags.length, 'other private tags')
        } catch (err) {
          // We could not read the private section. It is still THERE, and it is
          // still the user's data — publishing a freshly-encrypted content that
          // omits it would destroy bookmarks we merely failed to decrypt (a
          // dismissed NIP-46 prompt is enough). Flag it; the publish path refuses.
          privateSectionUnreadable = true
          debugWarn('[bookmarks] Failed to decrypt content:', err)
        }
      }

      const ids = [...new Set([...publicIds, ...privateIds])]
      debugLog('[bookmarks] Total:', ids.length, 'bookmark ids (public:', publicIds.length, ', private:', privateIds.length, ')')
      return {
        ids,
        found: true,
        hasPublicTags: publicIds.length > 0,
        foreignPublicTags,
        foreignPrivateTags,
        privateSectionUnreadable,
        rawContent: bookmarkEvent.content ?? '',
      }
    },
    enabled: !!user?.pubkey && fetchEnabled,
    staleTime: 5 * 60_000,
  })

  // Ref mirror so the debounced/timeout publish paths read the CURRENT remote
  // shape without adding `relayResult` to publishBookmarkList's deps (which
  // would re-arm every publish timer on each refetch).
  const relayResultRef = useRef<BookmarkListResult | undefined>(relayResult)
  relayResultRef.current = relayResult

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
    // Refuse to publish when the existing private section exists but couldn't be
    // decrypted: kind 10003 is replaceable, so a fresh `content` REPLACES it, and
    // we would be deleting private bookmarks we simply failed to read. (H2)
    const remote = relayResultRef.current
    if (remote?.privateSectionUnreadable) {
      debugError('[bookmarks] Publish refused — existing private bookmark section could not be decrypted; refusing to overwrite it')
      publishingRef.current = false
      return
    }

    publishingRef.current = true

    const isPublic = getPublicBookmarksPref()
    debugLog('[bookmarks] Publishing kind 10003 with', newIds.length, 'bookmarks (public:', isPublic, ')')

    try {
      const eTags = newIds.map(id => ['e', id])
      // Merge back every tag we did not author. NIP-51 bookmark lists are shared
      // across clients: `a` (articles), `t` (hashtags) and `r` (URLs) belong to
      // whatever client wrote them, and dropping them on our publish deleted
      // them from the user's account everywhere. (H2)
      const foreignPublic = remote?.foreignPublicTags ?? []
      const foreignPrivate = remote?.foreignPrivateTags ?? []

      const payload = JSON.stringify([...eTags, ...foreignPrivate])
      const encrypted = await encryptToSelf(currentUser.signer, currentUser.pubkey, payload)

      const event = await currentUser.signer.signEvent({
        kind: 10003,
        content: encrypted,
        // Public note tags only when the user opts in — but foreign public tags
        // are preserved either way, because they were never ours to hide.
        tags: isPublic ? [...eTags, ...foreignPublic] : [...foreignPublic],
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

      // NOTE: this used to silently re-publish the whole kind-10003 three seconds
      // after load whenever the on-relay public/private shape didn't match the
      // local preference. That is a write the user never asked for, fired on
      // every session, and it is exactly the write most likely to do damage: it
      // ran before anything had been verified, could flip a list PUBLIC (leaking
      // what the user reads) or private purely because a per-device IDB flag
      // said so, and it raced the load path. Converting between public and
      // private is a deliberate, consequential choice — it now happens ONLY when
      // the user toggles the preference, via republishBookmarks() below. (H2)
    }

    // Migration: if relay has no bookmark IDs (empty or missing), check for legacy collapsed-notes.
    // (M7) Only migrate/mark-done when the remote fetch actually SUCCEEDED (found:true —
    // an empty-but-confirmed list). A total failure (Promise.any rejected → found:false)
    // must NOT set the migrated flag, or a one-off relay outage permanently skips the
    // legacy migration. Leaving it unmarked lets it retry next session.
    if (relayResult.found && relayResult.ids.length === 0 && !hasMigrated.current()) {
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
    // Publish after any explicit add/remove — INCLUDING removing the last one.
    // The old `bookmarkIds.length === 0` guard meant clearing your final bookmark
    // never published the emptied kind-10003, so the relay's stale copy resurrected
    // it next session. needsPublish is set only by user actions, never initial load.
    if (!needsPublish.current) return
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
