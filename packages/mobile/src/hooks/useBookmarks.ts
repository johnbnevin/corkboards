/**
 * useBookmarks — NIP-51 kind 10003 private bookmark management.
 *
 * Mirrors the web version (packages/web/src/hooks/useBookmarks.ts).
 * Uses MMKV for local persistence instead of IndexedDB.
 *
 * - Reads the user's kind 10003 bookmark list from relays
 * - Stores bookmark IDs as encrypted private tags in the content field (NIP-44)
 * - Mirrors bookmark IDs as public e-tags when the user opts into public bookmarks
 * - Publishes updated kind 10003 events on add/remove
 * - Caches bookmark IDs in MMKV for instant startup
 *
 * ## One store, not one per hook instance (parity with web)
 *
 * The id list lives in a module-level store read via useSyncExternalStore.
 * Per-instance useState synced by a union-only merge could never propagate a
 * REMOVAL, which froze every other consumer's count at the old number.
 *
 * ## What this deliberately does NOT do anymore
 *
 * - No blind union with the relay copy: the merge is tombstone-aware, so an
 *   id removed locally (or by a restore) stays removed instead of being
 *   resurrected by a stale kind-10003 five minutes later.
 * - No auto-republish when the relay's public/private shape mismatches the
 *   local preference — web removed this deliberately (it could flip a list
 *   PUBLIC, leaking what the user reads, from a per-device flag); mobile had
 *   kept it. Conversion happens only via republishBookmarks().
 * - No publish that drops tags other clients wrote: kind 10003 is REPLACEABLE
 *   and shared across clients (`a` articles, `t` hashtags, `r` URLs, unknown
 *   private tags). They are carried through publish verbatim now, and a
 *   private section we failed to DECRYPT refuses to publish at all. (H2)
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr, FALLBACK_RELAYS, getUserRelays } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { mobileStorage, getStoredTombstones } from '../storage/MmkvStorage';
import { subscribeStorageSync } from '../lib/storageSync';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { mergeBookmarkSnapshot } from '@core/stateMerge';
import type { NostrEvent } from '@nostrify/nostrify';

const MMKV_KEY = 'nostr-bookmark-ids';
const STORE_WRITE_ORIGIN = 'bookmarks-store';

// ─── Module store ───────────────────────────────────────────────────────────

let _bookmarkIds: string[] = [];
let _storeInitialized = false;
const _bookmarkListeners = new Set<() => void>();

/** Ids the user explicitly un-bookmarked this session — the publish wipe
 *  guard exempts these (a shrink the user asked for is a cleanup; a shrink
 *  nobody asked for is state damage). */
const _sessionRemovedBookmarkIds = new Set<string>();

let _needsPublish = false;
let _publishing = false;

function readStoredBookmarks(): string[] {
  try {
    const stored = mobileStorage.getSync(MMKV_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

function setBookmarkStore(next: string[], persist: boolean): void {
  if (sameIds(next, _bookmarkIds)) return;
  _bookmarkIds = next;
  if (persist) {
    try {
      mobileStorage.setSync(MMKV_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
  }
  for (const listener of _bookmarkListeners) listener();
}

function subscribeBookmarkStore(onChange: () => void): () => void {
  _bookmarkListeners.add(onChange);
  return () => { _bookmarkListeners.delete(onChange); };
}

function getBookmarkSnapshot(): string[] {
  return _bookmarkIds;
}

/** Module-level add/remove so useCollapsedNotes (dismiss-from-saved, undo) can
 *  update bookmarks without a React context. The publish is picked up by any
 *  mounted useBookmarks instance's effect. */
export function storeAddBookmark(noteId: string): void {
  if (_bookmarkIds.includes(noteId)) return;
  _sessionRemovedBookmarkIds.delete(noteId);
  _needsPublish = true;
  setBookmarkStore([..._bookmarkIds, noteId], true);
}

export function storeRemoveBookmark(noteId: string): void {
  if (!_bookmarkIds.includes(noteId)) return;
  _sessionRemovedBookmarkIds.add(noteId);
  _needsPublish = true;
  setBookmarkStore(_bookmarkIds.filter(id => id !== noteId), true);
}

/** Clear all module state (logout / account switch). */
export function clearBookmarksModuleState(): void {
  _bookmarkIds = [];
  _storeInitialized = false;
  _sessionRemovedBookmarkIds.clear();
  _needsPublish = false;
  for (const listener of _bookmarkListeners) listener();
}

function initBookmarkStore(): void {
  if (_storeInitialized) return;
  _storeInitialized = true;
  _bookmarkIds = readStoredBookmarks();

  // External writes (backup merge, account switch): REPLACE, don't union —
  // the stored value passed the tombstone choke point and is authoritative.
  subscribeStorageSync((key, value, origin) => {
    if (key !== MMKV_KEY || origin === STORE_WRITE_ORIGIN) return;
    if (value === null) {
      setBookmarkStore([], false);
      return;
    }
    setBookmarkStore(readStoredBookmarks(), false);
  });
}

/**
 * What we read off the user's kind-10003, including the parts this app
 * doesn't own — see web's BookmarkListResult for the full reasoning. (H2)
 */
interface BookmarkListResult {
  ids: string[];
  found: boolean;
  /** The event's created_at — lets the tombstone merge age the relay copy. */
  createdAt: number;
  hasPublicTags: boolean;
  foreignPublicTags: string[][];
  foreignPrivateTags: string[][];
  privateSectionUnreadable: boolean;
}

const EMPTY_BOOKMARK_RESULT: BookmarkListResult = {
  ids: [], found: false, createdAt: 0, hasPublicTags: false,
  foreignPublicTags: [], foreignPrivateTags: [],
  privateSectionUnreadable: false,
};

/** Read the public-bookmarks preference (default: false = private) */
function getPublicBookmarksPref(): boolean {
  try {
    return mobileStorage.getSync(STORAGE_KEYS.PUBLIC_BOOKMARKS) === 'true';
  } catch { return false; }
}

export function useBookmarks(fetchEnabled = true) {
  const { pubkey, signer } = useAuth();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  // Keep the latest pubkey/signer in a ref so long-lived async callbacks don't
  // capture stale values. Updating in a useEffect (post-commit) instead of
  // during render avoids the react-hooks/refs lint and the
  // "ref-mutation-during-render" warning React 19 will start emitting.
  const userRef = useRef({ pubkey, signer });
  useEffect(() => {
    userRef.current = { pubkey, signer };
  }, [pubkey, signer]);

  initBookmarkStore();
  const bookmarkIds = useSyncExternalStore(subscribeBookmarkStore, getBookmarkSnapshot, getBookmarkSnapshot);

  const isMountedRef = useRef(true);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (publishTimer.current) clearTimeout(publishTimer.current);
    };
  }, []);

  // Fetch bookmark list (kind 10003) from relays
  const { data: relayResult, isLoading } = useQuery({
    queryKey: ['bookmarks', pubkey],
    queryFn: async (): Promise<BookmarkListResult> => {
      if (!pubkey || !signer) return EMPTY_BOOKMARK_RESULT;

      const userRelays = getUserRelays();
      const writeRelays = userRelays.write.length > 0 ? userRelays.write : FALLBACK_RELAYS;

      let bookmarkEvent: NostrEvent;
      try {
        bookmarkEvent = await Promise.any(
          writeRelays.map(async (relayUrl) => {
            const relay = nostr.relay(relayUrl);
            const [ev] = await relay.query(
              [{ kinds: [10003], authors: [pubkey], limit: 1 }],
              { signal: AbortSignal.timeout(5000) },
            );
            if (!ev) throw new Error('no bookmark list');
            return ev;
          }),
        );
      } catch {
        return EMPTY_BOOKMARK_RESULT;
      }

      // Public tags (ours = `e` tags; everything else belongs to other clients)
      const publicIds = bookmarkEvent.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1]);
      const foreignPublicTags = bookmarkEvent.tags.filter(t => !(t[0] === 'e' && t[1]));

      // Private tags (encrypted in content via NIP-44)
      let privateIds: string[] = [];
      let foreignPrivateTags: string[][] = [];
      let privateSectionUnreadable = false;
      if (bookmarkEvent.content) {
        if (signer.nip44) {
          try {
            const decrypted = await signer.nip44.decrypt(pubkey, bookmarkEvent.content);
            const tags = JSON.parse(decrypted) as string[][];
            privateIds = tags.filter(t => t[0] === 'e' && t[1]).map(t => t[1]);
            foreignPrivateTags = tags.filter(t => !(t[0] === 'e' && t[1]));
          } catch (err) {
            // The section is still the user's data — flag it; publish refuses. (H2)
            privateSectionUnreadable = true;
            if (__DEV__) console.warn('[bookmarks] Failed to decrypt content:', err);
          }
        } else {
          privateSectionUnreadable = true;
        }
      }

      return {
        ids: [...new Set([...publicIds, ...privateIds])],
        found: true,
        createdAt: bookmarkEvent.created_at,
        hasPublicTags: publicIds.length > 0,
        foreignPublicTags,
        foreignPrivateTags,
        privateSectionUnreadable,
      };
    },
    enabled: !!pubkey && !!signer && fetchEnabled,
    staleTime: 5 * 60_000,
  });

  // Ref mirror so the debounced publish reads the CURRENT remote shape.
  const relayResultRef = useRef<BookmarkListResult | undefined>(relayResult);
  useEffect(() => { relayResultRef.current = relayResult; }, [relayResult]);

  // Publish updated kind 10003 bookmark list to relays
  const publishBookmarkList = useCallback(async (newIds: string[]) => {
    const current = userRef.current;
    if (!current.pubkey || !current.signer?.nip44) return;
    if (_publishing) return;

    const remote = relayResultRef.current;
    // A private section we failed to decrypt would be REPLACED by our fresh
    // content — deleting bookmarks we merely failed to read. Refuse. (H2)
    if (remote?.privateSectionUnreadable) {
      if (__DEV__) console.error('[bookmarks] Publish refused — existing private section unreadable');
      return;
    }
    // Wipe guard: a mass shrink is allowed only for ids the user removed by
    // explicit action this session — anything else means damaged local state,
    // and kind 10003 is replaceable, so publishing it wipes account-wide.
    if (remote?.found && remote.ids.length > 10) {
      const newIdSet = new Set(newIds);
      const unexplained = remote.ids.filter(
        id => !newIdSet.has(id) && !_sessionRemovedBookmarkIds.has(id),
      );
      if (unexplained.length > remote.ids.length / 2) {
        if (__DEV__) console.error(`[bookmarks] Publish refused — would drop ${unexplained.length} of ${remote.ids.length} remote bookmarks never explicitly removed this session`);
        return;
      }
    }

    _publishing = true;
    const isPublic = getPublicBookmarksPref();

    try {
      const eTags = newIds.map(id => ['e', id]);
      // Carry through every tag other clients wrote — public and private. (H2)
      const foreignPublic = remote?.foreignPublicTags ?? [];
      const foreignPrivate = remote?.foreignPrivateTags ?? [];

      const payload = JSON.stringify([...eTags, ...foreignPrivate]);
      const encrypted = await current.signer.nip44.encrypt(current.pubkey, payload);

      const event = await current.signer.signEvent({
        kind: 10003,
        content: encrypted,
        tags: isPublic ? [...eTags, ...foreignPublic] : [...foreignPublic],
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      queryClient.invalidateQueries({ queryKey: ['bookmarks', current.pubkey] });
    } catch (err) {
      if (__DEV__) console.error('[bookmarks] Publish failed:', err);
    } finally {
      _publishing = false;
    }
  }, [nostr, queryClient]);

  // Sync local state when relay data arrives — tombstone-aware, NOT a union:
  // an id removed locally whose grave is newer than this relay event stays
  // removed instead of resurrecting when the stale copy refreshes.
  useEffect(() => {
    if (!relayResult || !pubkey) return;
    if (relayResult.found && relayResult.ids.length > 0) {
      const graves = getStoredTombstones()[MMKV_KEY] ?? {};
      const merged = mergeBookmarkSnapshot(_bookmarkIds, relayResult.ids, relayResult.createdAt, graves);
      if (merged.changed) setBookmarkStore(merged.ids, true);
    }
  }, [relayResult, pubkey]);

  // Schedule publish when the store changed from a user action.
  // Always resets the debounce timer so rapid toggles accumulate into one publish.
  useEffect(() => {
    // Publish after any explicit add/remove — INCLUDING removing the last one.
    // The old `bookmarkIds.length === 0` guard meant clearing your final bookmark
    // never published the emptied kind-10003, so the relay's stale copy resurrected
    // it next session. _needsPublish is set only by user actions, never initial load.
    if (!_needsPublish) return;
    _needsPublish = false;
    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => {
      publishBookmarkList(_bookmarkIds);
    }, 1500);
  }, [bookmarkIds, publishBookmarkList]);

  const bookmarkSet = useSetMemo(bookmarkIds);

  const addBookmark = useCallback((noteId: string) => {
    storeAddBookmark(noteId);
  }, []);

  const removeBookmark = useCallback((noteId: string) => {
    storeRemoveBookmark(noteId);
  }, []);

  const toggleBookmark = useCallback((noteId: string) => {
    if (_bookmarkIds.includes(noteId)) {
      storeRemoveBookmark(noteId);
    } else {
      storeAddBookmark(noteId);
    }
  }, []);

  const isBookmarked = useCallback((noteId: string) => bookmarkSet.has(noteId), [bookmarkSet]);

  /** Re-publish current bookmarks (e.g. after toggling public/private preference) */
  const republishBookmarks = useCallback(() => {
    if (_bookmarkIds.length > 0) publishBookmarkList(_bookmarkIds);
  }, [publishBookmarkList]);

  return {
    bookmarkIds,
    bookmarkSet,
    isBookmarked,
    addBookmark,
    removeBookmark,
    toggleBookmark,
    republishBookmarks,
    isLoading,
  };
}

// Small helper: a Set memo keyed on the array identity (the store swaps the
// array only on real change, so this recomputes exactly when needed).
const _setMemoCache = new WeakMap<string[], Set<string>>();
function useSetMemo(ids: string[]): Set<string> {
  let cached = _setMemoCache.get(ids);
  if (!cached) {
    cached = new Set(ids);
    _setMemoCache.set(ids, cached);
  }
  return cached;
}
