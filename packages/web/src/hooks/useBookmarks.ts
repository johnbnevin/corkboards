/**
 * useBookmarks — NIP-51 kind 10003 private bookmark management.
 *
 * - Reads the user's kind 10003 bookmark list from relays
 * - Stores bookmark IDs as encrypted private tags in the content field
 * - Publishes updated kind 10003 events on add/remove
 * - Caches bookmark IDs in IDB for instant startup
 * - Designed to work alongside useCollapsedNotes for backward compatibility
 *
 * ## One store, not one per hook instance
 *
 * The id list lives in a module-level store that every hook instance reads
 * via useSyncExternalStore. It used to be per-instance useState kept in sync
 * only by a union-only IDB listener — which is structurally incapable of
 * propagating a REMOVAL, so unsaving a note updated whichever component did
 * it and left every other consumer (the saved-page header count, the tab
 * badge) frozen at the old number until reload. Removals are ordinary state
 * transitions now: one store shrinks, every subscriber re-renders.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useNostr } from '@nostrify/react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { debugLog, debugWarn, debugError } from '@/lib/debug'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getUserRelays, FALLBACK_RELAYS } from '@/components/NostrProvider'
import { idbGetSync, idbSetSync, getStoredTombstones } from '@/lib/idb'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import { mergeBookmarkSnapshot } from '@core/stateMerge'
import type { NostrEvent } from '@nostrify/nostrify'

const IDB_KEY = 'nostr-bookmark-ids'
const STORE_WRITE_ORIGIN = 'bookmarks-store'

// ─── Module store ───────────────────────────────────────────────────────────

let _bookmarkIds: string[] = []
let _bookmarkHydrated = false
let _storeInitialized = false
const _bookmarkListeners = new Set<() => void>()

/** Ids the user explicitly un-bookmarked this session. The publish wipe guard
 *  exempts these: a shrink the user asked for is a cleanup, a shrink nobody
 *  asked for is state damage that must not reach the replaceable event. */
const _sessionRemovedBookmarkIds = new Set<string>()

let _needsPublish = false
let _publishTimer: ReturnType<typeof setTimeout> | undefined
let _publishing = false

function readStoredBookmarks(): string[] {
  try {
    const stored = idbGetSync(IDB_KEY)
    const parsed = stored ? JSON.parse(stored) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id)
}

function setBookmarkStore(next: string[], persist: boolean): void {
  if (sameIds(next, _bookmarkIds)) return
  _bookmarkIds = next
  // Persist only once hydrated: before the IDB re-read lands, the store may
  // hold a partial list, and writing that would clobber restored data.
  if (persist && _bookmarkHydrated) {
    try {
      idbSetSync(IDB_KEY, JSON.stringify(next), STORE_WRITE_ORIGIN)
    } catch (e) {
      if (import.meta.env.DEV) console.error('[bookmarks] Failed to save to IDB:', e)
    }
  }
  for (const listener of _bookmarkListeners) listener()
}

function subscribeBookmarkStore(onChange: () => void): () => void {
  _bookmarkListeners.add(onChange)
  return () => { _bookmarkListeners.delete(onChange) }
}

function getBookmarkSnapshot(): string[] {
  return _bookmarkIds
}

/** Clear all module state (logout / account switch) — mirrors
 *  clearCollapsedNotesModuleState. */
export function clearBookmarksModuleState(): void {
  _bookmarkIds = []
  _bookmarkHydrated = false
  _storeInitialized = false
  _sessionRemovedBookmarkIds.clear()
  _needsPublish = false
  if (_publishTimer) { clearTimeout(_publishTimer); _publishTimer = undefined }
  for (const listener of _bookmarkListeners) listener()
}

function initBookmarkStore(): void {
  if (_storeInitialized) return
  _storeInitialized = true
  _bookmarkIds = readStoredBookmarks()
  debugLog('[bookmarks] IDB cache:', _bookmarkIds.length, 'ids')

  // External writes: restore/merge, account switch, cross-tab. REPLACE, don't
  // union — every write to this key passed the tombstone choke point, so the
  // stored value is authoritative and a union would resurrect removals.
  if (typeof window !== 'undefined') {
    window.addEventListener('idb-storage-sync', (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: unknown; origin?: string }>).detail
      if (detail.key !== IDB_KEY || detail.origin === STORE_WRITE_ORIGIN) return
      if (detail.value === null) {
        // Key deleted (account switch stash / wipe).
        setBookmarkStore([], false)
        return
      }
      setBookmarkStore(readStoredBookmarks(), false)
    })
  }

  // Re-read once IDB warms up — memCache may have been empty at init. Union
  // with whatever the session added in the window, then persistence is safe.
  import('@/lib/idb').then(({ idbReady }) => idbReady).then(() => {
    const stored = readStoredBookmarks()
    const merged = [...new Set([...stored, ..._bookmarkIds])]
    _bookmarkHydrated = true
    if (!sameIds(merged, stored)) {
      setBookmarkStore(merged, true)
    } else {
      setBookmarkStore(merged, false)
    }
  }).catch(() => { _bookmarkHydrated = true })
}

// ─── Relay shapes ───────────────────────────────────────────────────────────

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
  /** The event's created_at — lets the tombstone merge age the relay copy. */
  createdAt: number
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
  ids: [], found: false, createdAt: 0, hasPublicTags: false,
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
  // Ref to avoid stale closure when setTimeout fires after user changes
  const userRef = useRef(user)
  userRef.current = user

  initBookmarkStore()
  const bookmarkIds = useSyncExternalStore(subscribeBookmarkStore, getBookmarkSnapshot, getBookmarkSnapshot)

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
        createdAt: bookmarkEvent.created_at,
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
    if (_publishing) {
      debugWarn('[bookmarks] Publish skipped — already publishing')
      return
    }
    // Refuse to publish when the existing private section exists but couldn't be
    // decrypted: kind 10003 is replaceable, so a fresh `content` REPLACES it, and
    // we would be deleting private bookmarks we simply failed to read. (H2)
    const remote = relayResultRef.current
    if (remote?.privateSectionUnreadable) {
      debugError('[bookmarks] Publish refused — existing private bookmark section could not be decrypted; refusing to overwrite it')
      return
    }
    // Wipe guard (mirrors @core/contactList's "nothing confirmable → abort"):
    // kind 10003 is replaceable, so a publish derived from damaged local state
    // (an empty memCache at startup, a half-hydrated store) would erase the
    // user's bookmarks account-wide. A mass shrink is allowed only for ids the
    // user removed by explicit action this session.
    if (remote?.found && remote.ids.length > 10) {
      const newIdSet = new Set(newIds)
      const unexplained = remote.ids.filter(
        id => !newIdSet.has(id) && !_sessionRemovedBookmarkIds.has(id),
      )
      if (unexplained.length > remote.ids.length / 2) {
        debugError(
          `[bookmarks] Publish refused — would drop ${unexplained.length} of ${remote.ids.length} remote bookmarks that were never explicitly removed this session; local state may be damaged`,
        )
        return
      }
    }

    _publishing = true

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
      _publishing = false
    }
  }, [nostr, queryClient])

  // Sync local state when relay data arrives, and handle migration
  useEffect(() => {
    if (!relayResult || !user?.pubkey) return

    debugLog('[bookmarks] Sync effect — relay found:', relayResult.found, 'ids:', relayResult.ids.length, 'hasPublicTags:', relayResult.hasPublicTags)

    if (relayResult.found && relayResult.ids.length > 0) {
      // Newest-wins with tombstones, NOT a blind union: an id removed locally
      // (or by a restore) whose grave is newer than this relay event stays
      // removed — the relay copy is stale, and re-unioning it was exactly the
      // "count reverts five minutes later" resurrection bug.
      const graves = getStoredTombstones()[IDB_KEY] ?? {}
      const merged = mergeBookmarkSnapshot(_bookmarkIds, relayResult.ids, relayResult.createdAt, graves)
      if (merged.changed) {
        debugLog('[bookmarks] Merged relay bookmarks:', _bookmarkIds.length, '→', merged.ids.length)
        setBookmarkStore(merged.ids, true)
      } else {
        debugLog('[bookmarks] Relay bookmarks already reflected in local state')
      }

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
            const idsToPublish = [...new Set([..._bookmarkIds, ...legacyIds])]
            setBookmarkStore(idsToPublish, true)
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

  const bookmarkSet = useSetMemo(bookmarkIds)

  useEffect(() => {
    // Publish after any explicit add/remove — INCLUDING removing the last one.
    // The old `bookmarkIds.length === 0` guard meant clearing your final bookmark
    // never published the emptied kind-10003, so the relay's stale copy resurrected
    // it next session. _needsPublish is set only by user actions, never initial load.
    if (!_needsPublish) return
    _needsPublish = false
    debugLog('[bookmarks] Scheduling publish for', bookmarkIds.length, 'bookmarks')
    if (_publishTimer) clearTimeout(_publishTimer)
    _publishTimer = setTimeout(() => {
      _publishTimer = undefined
      publishBookmarkList(_bookmarkIds)
    }, 1500)
  }, [bookmarkIds, publishBookmarkList])

  const addBookmark = useCallback((noteId: string) => {
    if (_bookmarkIds.includes(noteId)) return
    debugLog('[bookmarks] addBookmark:', noteId.slice(0, 8))
    _sessionRemovedBookmarkIds.delete(noteId)
    _needsPublish = true
    setBookmarkStore([..._bookmarkIds, noteId], true)
  }, [])

  const removeBookmark = useCallback((noteId: string) => {
    if (!_bookmarkIds.includes(noteId)) return
    debugLog('[bookmarks] removeBookmark:', noteId.slice(0, 8))
    _sessionRemovedBookmarkIds.add(noteId)
    _needsPublish = true
    setBookmarkStore(_bookmarkIds.filter(id => id !== noteId), true)
  }, [])

  const toggleBookmark = useCallback((noteId: string) => {
    if (_bookmarkIds.includes(noteId)) {
      removeBookmark(noteId)
    } else {
      addBookmark(noteId)
    }
  }, [addBookmark, removeBookmark])

  const isBookmarked = useCallback((noteId: string) => bookmarkSet.has(noteId), [bookmarkSet])

  /** Re-publish current bookmarks (e.g. after toggling public/private preference) */
  const republishBookmarks = useCallback(() => {
    if (_bookmarkIds.length > 0) publishBookmarkList(_bookmarkIds)
  }, [publishBookmarkList])

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

// Small helper: a Set memo keyed on the array identity (the store swaps the
// array only on real change, so this recomputes exactly when needed).
const _setMemoCache = new WeakMap<string[], Set<string>>()
function useSetMemo(ids: string[]): Set<string> {
  let cached = _setMemoCache.get(ids)
  if (!cached) {
    cached = new Set(ids)
    _setMemoCache.set(ids, cached)
  }
  return cached
}
