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
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr, FALLBACK_RELAYS, getUserRelays } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';
import type { NostrEvent } from '@nostrify/nostrify';

const MMKV_KEY = 'nostr-bookmark-ids';

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
  const publishingRef = useRef(false);
  // Keep the latest pubkey/signer in a ref so long-lived async callbacks don't
  // capture stale values. Updating in a useEffect (post-commit) instead of
  // during render avoids the react-hooks/refs lint and the
  // "ref-mutation-during-render" warning React 19 will start emitting.
  const userRef = useRef({ pubkey, signer });
  useEffect(() => {
    userRef.current = { pubkey, signer };
  }, [pubkey, signer]);

  // Local bookmark IDs for instant UI (synced from relay + MMKV cache)
  const [bookmarkIds, setBookmarkIds] = useState<string[]>(() => {
    try {
      const stored = mobileStorage.getSync(MMKV_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const isMountedRef = useRef(true);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const needsPublish = useRef(false);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (publishTimer.current) clearTimeout(publishTimer.current);
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, []);

  // Persist to MMKV whenever bookmarkIds changes
  useEffect(() => {
    try {
      mobileStorage.setSync(MMKV_KEY, JSON.stringify(bookmarkIds));
    } catch {
      // ignore
    }
  }, [bookmarkIds]);

  // Fetch bookmark list (kind 10003) from relays
  const { data: relayResult, isLoading } = useQuery({
    queryKey: ['bookmarks', pubkey],
    queryFn: async (): Promise<{ ids: string[]; found: boolean; hasPublicTags: boolean }> => {
      if (!pubkey || !signer) return { ids: [], found: false, hasPublicTags: false };

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
        return { ids: [], found: false, hasPublicTags: false };
      }

      // bookmarkEvent is guaranteed assigned at this point (Promise.any catch returns early)

      // Public tags
      const publicIds = bookmarkEvent.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1]);

      // Private tags (encrypted in content via NIP-44)
      let privateIds: string[] = [];
      if (bookmarkEvent.content && signer.nip44) {
        try {
          const decrypted = await signer.nip44.decrypt(pubkey, bookmarkEvent.content);
          const tags = JSON.parse(decrypted) as string[][];
          privateIds = tags.filter(t => t[0] === 'e' && t[1]).map(t => t[1]);
        } catch (err) {
          if (__DEV__) console.warn('[bookmarks] Failed to decrypt content:', err);
        }
      }

      return {
        ids: [...new Set([...publicIds, ...privateIds])],
        found: true,
        hasPublicTags: publicIds.length > 0,
      };
    },
    enabled: !!pubkey && !!signer && fetchEnabled,
    staleTime: 5 * 60_000,
  });

  // Publish updated kind 10003 bookmark list to relays
  const publishBookmarkList = useCallback(async (newIds: string[]) => {
    const current = userRef.current;
    if (!current.pubkey || !current.signer?.nip44) return;
    if (publishingRef.current) return;
    publishingRef.current = true;

    // Public bookmarks mirror the ids as plaintext e-tags; private keeps them
    // only in the NIP-44 encrypted content (parity with web's useBookmarks).
    const isPublic = getPublicBookmarksPref();

    try {
      const eTags = newIds.map(id => ['e', id]);
      const payload = JSON.stringify(eTags);
      const encrypted = await current.signer.nip44.encrypt(current.pubkey, payload);

      const event = await current.signer.signEvent({
        kind: 10003,
        content: encrypted,
        tags: isPublic ? eTags : [], // public tags only when user opts in
        created_at: Math.floor(Date.now() / 1000),
      });
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      queryClient.invalidateQueries({ queryKey: ['bookmarks', current.pubkey] });
    } catch (err) {
      if (__DEV__) console.error('[bookmarks] Publish failed:', err);
    } finally {
      publishingRef.current = false;
    }
  }, [nostr, queryClient]);

  // Sync local state when relay data arrives. Functional updater + identity
  // check below ensures the cascade the v7 set-state-in-effect rule fears
  // can't actually happen (only fires when content differs).
  useEffect(() => {
    if (!relayResult || !pubkey) return;
    if (relayResult.found && relayResult.ids.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBookmarkIds(prev => {
        const merged = [...new Set([...relayResult.ids, ...prev])];
        if (merged.length === prev.length && merged.every(id => prev.includes(id))) return prev;
        return merged;
      });

      // Re-publish if the relay list's public/private state doesn't match the
      // user's preference (parity with web's useBookmarks sync effect).
      if (relayResult.hasPublicTags !== getPublicBookmarksPref()) {
        if (syncTimer.current) clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => {
          if (isMountedRef.current && userRef.current.pubkey) publishBookmarkList(relayResult.ids);
        }, 3000);
      }
    }
  }, [relayResult, pubkey, publishBookmarkList]);

  // Schedule publish when bookmarkIds changes from user action.
  // Always resets the debounce timer so rapid toggles accumulate into one publish.
  useEffect(() => {
    if (!needsPublish.current || bookmarkIds.length === 0) return;
    needsPublish.current = false;
    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => {
      publishBookmarkList(bookmarkIds);
    }, 1500);
  }, [bookmarkIds, publishBookmarkList]);

  const bookmarkSet = useMemo(() => new Set(bookmarkIds), [bookmarkIds]);

  const addBookmark = useCallback((noteId: string) => {
    setBookmarkIds(prev => {
      if (prev.includes(noteId)) return prev;
      needsPublish.current = true;
      return [...prev, noteId];
    });
  }, []);

  const removeBookmark = useCallback((noteId: string) => {
    setBookmarkIds(prev => {
      if (!prev.includes(noteId)) return prev;
      needsPublish.current = true;
      return prev.filter(id => id !== noteId);
    });
  }, []);

  const toggleBookmark = useCallback((noteId: string) => {
    if (bookmarkSet.has(noteId)) {
      removeBookmark(noteId);
    } else {
      addBookmark(noteId);
    }
  }, [bookmarkSet, addBookmark, removeBookmark]);

  const isBookmarked = useCallback((noteId: string) => bookmarkSet.has(noteId), [bookmarkSet]);

  /** Re-publish current bookmarks (e.g. after toggling public/private preference) */
  const republishBookmarks = useCallback(() => {
    if (bookmarkIds.length > 0) publishBookmarkList(bookmarkIds);
  }, [bookmarkIds, publishBookmarkList]);

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
