/**
 * useFeedPagination — Centralises "load older" and "load newer" logic for mobile.
 *
 * Ported from packages/web/src/hooks/useFeedPagination.ts.
 * Adapted for mobile: no IntersectionObserver (FlatList onEndReached),
 * no relay tabs, simplified tab types.
 *
 * It owns:
 *  - hasMore / isLoadingMore / isLoadingNewer
 *  - newerNotes (events prepended to the feed after a "load newer" call)
 *  - freshNoteIds (IDs highlighted briefly after being loaded)
 *  - newestTimestamp (tracks the leading edge for "since" queries)
 *  - batchProgress (shown while batched all-follows queries run)
 *  - loadingMessage (shown in loading indicator)
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';
import { useQueryClient } from '@tanstack/react-query';
import { batchFetchByAuthors, FEED_KINDS } from '../lib/feedUtils';

export interface CustomFeedDef {
  id: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
}

export interface UseFeedPaginationOptions {
  activeTab: string;
  userPubkey: string | undefined;
  contacts: string[] | undefined;
  activeCustomFeed: CustomFeedDef | null;
  /** Note limit per fetch */
  limit: number;
  /** Feed multiplier (1x, 2x, 3x) */
  multiplier?: number;
  /** Pre-filtered notes currently displayed for the active tab */
  currentNotes: NostrEvent[];
  /** Current notes from each feed data-source (for React-Query cache keys) */
  userNotes: NostrEvent[] | undefined;
  allFollowsNotes: NostrEvent[] | undefined;
  customFeedNotes: NostrEvent[] | undefined;
  friendNotes: NostrEvent[] | undefined;
  /** Add notes to custom feed cache */
  addCustomFeedNotes?: (events: NostrEvent[]) => void;
  /** Called when loadMoreByCount fetches notes for the 'me' tab */
  onMeTabNotesLoaded?: (notes: NostrEvent[]) => void;
  /** Whether "include my notes" is enabled for the current tab */
  showOwnNotes?: boolean;
}

export interface UseFeedPaginationResult {
  hasMore: Record<string, boolean>;
  isLoadingMore: boolean;
  isLoadingNewer: boolean;
  loadingMessage: string | null;
  newerNotes: NostrEvent[];
  freshNoteIds: Set<string>;
  newestTimestamp: number | null;
  lastFetchTime: number | null;
  batchProgress: { loaded: number; total: number } | null;
  loadMoreNotes: (hours: number) => Promise<void>;
  loadMoreByCount: (count: number) => Promise<void>;
  loadNewerNotes: () => Promise<void>;
  setBatchProgress: (p: { loaded: number; total: number } | null) => void;
  hoursLoaded: number;
}

export function useFeedPagination({
  activeTab,
  userPubkey,
  contacts,
  activeCustomFeed,
  limit,
  multiplier: _multiplier = 1,
  currentNotes,
  userNotes,
  allFollowsNotes,
  customFeedNotes,
  friendNotes,
  addCustomFeedNotes,
  onMeTabNotesLoaded,
  showOwnNotes,
}: UseFeedPaginationOptions): UseFeedPaginationResult {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [freshNoteIds, setFreshNoteIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{ loaded: number; total: number } | null>(null);

  const messageClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-tab state stored in Maps (see web version for rationale)
  const newerNotesMap = useRef(new Map<string, NostrEvent[]>());
  const newestTimestampMap = useRef(new Map<string, number>());
  const lastFetchTimeMap = useRef(new Map<string, number>());
  const hoursLoadedMap = useRef(new Map<string, number>());

  // Derive current tab's values from maps
  const newerNotes = newerNotesMap.current.get(activeTab) || [];
  const newestTimestamp = newestTimestampMap.current.get(activeTab) ?? null;
  const lastFetchTime = lastFetchTimeMap.current.get(activeTab) ?? null;
  const hoursLoadedRef = useRef(hoursLoadedMap.current.get(activeTab) || 0);

  // Helpers to update per-tab state
  const [, forceUpdate] = useState(0);
  const setNewerNotes = useCallback((updater: NostrEvent[] | ((prev: NostrEvent[]) => NostrEvent[])) => {
    const prev = newerNotesMap.current.get(activeTab) || [];
    const next = typeof updater === 'function' ? updater(prev) : updater;
    newerNotesMap.current.set(activeTab, next);
    forceUpdate(c => c + 1);
  }, [activeTab]);
  const setNewestTimestamp = useCallback((updater: number | null | ((prev: number | null) => number | null)) => {
    const prev = newestTimestampMap.current.get(activeTab) ?? null;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return;
    if (next === null) newestTimestampMap.current.delete(activeTab);
    else newestTimestampMap.current.set(activeTab, next);
    forceUpdate(c => c + 1);
  }, [activeTab]);
  const setLastFetchTime = useCallback((updater: number | null | ((prev: number | null) => number | null)) => {
    const prev = lastFetchTimeMap.current.get(activeTab) ?? null;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return;
    if (next === null) lastFetchTimeMap.current.delete(activeTab);
    else lastFetchTimeMap.current.set(activeTab, next);
    forceUpdate(c => c + 1);
  }, [activeTab]);

  // Sync hoursLoadedRef with per-tab map
  useEffect(() => {
    hoursLoadedRef.current = hoursLoadedMap.current.get(activeTab) || 0;
  }, [activeTab]);

  // Track active tab so async operations can bail if user switched tabs
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Derived tab-type flags
  const isCustomFeedTab = activeTab.startsWith('feed:');
  const isAllFollowsTab = activeTab === 'all-follows';
  const isFriendTab = !isCustomFeedTab && !isAllFollowsTab && activeTab !== 'me' && activeTab !== 'discover' && activeTab !== 'saved' && activeTab !== 'notifications';

  // Track newest timestamp from displayed notes
  useEffect(() => {
    if (currentNotes.length > 0) {
      const notesToTrack = activeTab === 'me'
        ? currentNotes
        : (userPubkey ? currentNotes.filter(n => n.pubkey !== userPubkey) : currentNotes);

      if (notesToTrack.length > 0) {
        const newest = notesToTrack.reduce((max, n) => n.created_at > max ? n.created_at : max, notesToTrack[0].created_at);
        setNewestTimestamp(prev => (prev === null || newest > prev ? newest : prev));
        setLastFetchTime(prev => prev ?? Math.floor(Date.now() / 1000));
      }
    }
  }, [currentNotes, userPubkey, activeTab, setLastFetchTime, setNewestTimestamp]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (messageClearRef.current) clearTimeout(messageClearRef.current);
    };
  }, []);

  // Show a message briefly, then clear it
  const showBriefMessage = useCallback((msg: string, delayMs = 5000) => {
    setLoadingMessage(msg);
    if (messageClearRef.current) clearTimeout(messageClearRef.current);
    messageClearRef.current = setTimeout(() => setLoadingMessage(null), delayMs);
  }, []);

  // ─── Fetch & merge user notes into cache (for "include my notes") ──────────
  const fetchAndMergeUserNotes = useCallback(async (opts: { since?: number; until?: number; limit?: number }) => {
    if (!showOwnNotes || !userPubkey || activeTab === 'me') return;
    const userNotesKey = ['user-notes', userPubkey] as const;
    try {
      const filter: Record<string, unknown> = {
        kinds: [...FEED_KINDS],
        authors: [userPubkey],
      };
      if (opts.since != null) filter.since = opts.since;
      if (opts.until != null) filter.until = opts.until;
      if (opts.limit != null) filter.limit = opts.limit;

      const myEvents = await nostr.query([filter as never], { signal: AbortSignal.timeout(5000) });
      if (myEvents.length > 0) {
        const cached = (queryClient.getQueryData(userNotesKey) as NostrEvent[] | undefined) ?? [];
        const existingIds = new Set(cached.map(n => n.id));
        const trulyNew = myEvents.filter(n => !existingIds.has(n.id));
        if (trulyNew.length > 0) {
          queryClient.setQueryData(userNotesKey, [...cached, ...trulyNew].sort((a, b) => b.created_at - a.created_at));
        }
      }
    } catch {
      // Non-critical
    }
  }, [showOwnNotes, userPubkey, activeTab, nostr, queryClient]);

  // ─── Load Older (time-based pagination) ────────────────────────────────────

  const loadMoreNotes = useCallback(async (hours: number) => {
    if (__DEV__) console.log('[loadMore] hours:', hours, 'tab:', activeTab);
    if (isLoadingMore) return;
    const requestTab = activeTab;

    // Determine which cached data to use
    let currentTabNotes: NostrEvent[] = [];
    if (activeTab === 'me') {
      currentTabNotes = userNotes || [];
    } else if (isAllFollowsTab) {
      currentTabNotes = allFollowsNotes || [];
    } else if (isCustomFeedTab && activeCustomFeed) {
      currentTabNotes = customFeedNotes || [];
    } else if (isFriendTab) {
      currentTabNotes = friendNotes || [];
    }

    // Match useFollowNotesCache allAuthors calculation
    const userInContacts = contacts?.includes(userPubkey ?? '') ?? false;
    const allAuthorsCount = (contacts?.length ?? 0) + (userPubkey && !userInContacts ? 1 : 0);
    const followCacheKey: unknown[] = ['follow-notes-cache', allAuthorsCount > 0];
    const userNotesKey = ['user-notes', userPubkey] as const;

    const visibleNotes = currentNotes.length > 0 ? currentNotes : currentTabNotes;
    const hoursBackFromNow = hoursLoadedRef.current * 3600;
    const now = Math.floor(Date.now() / 1000);

    let hoursToFetch = hours;
    let didDoubleFetch = false;

    let anchorTimestamp: number;
    if (visibleNotes.length > 0) {
      const notesFromOthers = visibleNotes.filter(n => n.pubkey !== userPubkey);
      anchorTimestamp = notesFromOthers.length > 0
        ? notesFromOthers.reduce((min, n) => n.created_at < min ? n.created_at : min, notesFromOthers[0].created_at)
        : visibleNotes.reduce((min, n) => n.created_at < min ? n.created_at : min, visibleNotes[0].created_at);
    } else if (hoursBackFromNow > 0) {
      anchorTimestamp = now - hoursBackFromNow;
    } else {
      hoursToFetch = hours * 2;
      didDoubleFetch = true;
      anchorTimestamp = now;
    }

    let authorCount = contacts?.length ?? 0;
    if (isCustomFeedTab && activeCustomFeed) {
      authorCount = activeCustomFeed.pubkeys?.length ?? 0;
    }

    setIsLoadingMore(true);
    if (visibleNotes.length === 0) {
      const fetchHours = didDoubleFetch ? hoursToFetch : hours;
      setLoadingMessage(`No notes in cache — fetching ${fetchHours} hours…`);
    }

    hoursLoadedRef.current += hours;
    hoursLoadedMap.current.set(activeTab, hoursLoadedRef.current);

    const until = anchorTimestamp - 1;
    const since = until - (hoursToFetch * 3600);

    try {
      const signal = AbortSignal.timeout(10000);
      let newEvents: NostrEvent[] = [];

      if (activeTab === 'me' && userPubkey) {
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: [userPubkey],
          since,
          until,
          limit,
        }], { signal });
      } else if (isAllFollowsTab && contacts && contacts.length > 0) {
        newEvents = await batchFetchByAuthors({
          nostr,
          authors: contacts,
          limit,
          since,
          until,
          onProgress: (loaded, total) => setBatchProgress({ loaded, total }),
        });
        setBatchProgress(null);
      } else if (isCustomFeedTab && activeCustomFeed) {
        const hasPubkeys = (activeCustomFeed.pubkeys?.length ?? 0) > 0;
        if (hasPubkeys) {
          newEvents = await nostr.query([{
            kinds: [...FEED_KINDS],
            authors: activeCustomFeed.pubkeys,
            since,
            until,
            limit,
          }], { signal });
        } else {
          setHasMore(prev => ({ ...prev, [activeTab]: false }));
          setIsLoadingMore(false);
          setLoadingMessage(null);
          return;
        }
      } else if (isFriendTab) {
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: [activeTab],
          since,
          until,
          limit,
        }], { signal });
      }

      // Also fetch user notes for the same window (for dovetailing)
      await fetchAndMergeUserNotes({ since, until, limit });

      // Bail if user switched tabs while we were fetching
      if (activeTabRef.current !== requestTab) {
        if (__DEV__) console.log('[loadMore] tab changed, discarding results');
        return;
      }

      let addedCount = 0;
      if (newEvents.length > 0) {
        if (activeTab === 'me' && userPubkey) {
          const cached = (queryClient.getQueryData(userNotesKey) as NostrEvent[] | undefined) ?? [];
          const existingIds = new Set(cached.map(n => n.id));
          const trulyNew = newEvents.filter(n => !existingIds.has(n.id));
          addedCount = trulyNew.length;
          if (trulyNew.length > 0) {
            queryClient.setQueryData(userNotesKey, [...cached, ...trulyNew].sort((a, b) => b.created_at - a.created_at));
          }
        } else if (isCustomFeedTab && addCustomFeedNotes) {
          addCustomFeedNotes(newEvents);
          addedCount = newEvents.length;
        } else {
          const existing = (queryClient.getQueryData(followCacheKey) as NostrEvent[] | undefined) ?? [];
          const existingIds = new Set(existing.map(e => e.id));
          const trulyNew = newEvents.filter(n => !existingIds.has(n.id));
          addedCount = trulyNew.length;
          if (trulyNew.length > 0) {
            queryClient.setQueryData(followCacheKey, [...existing, ...trulyNew].sort((a, b) => b.created_at - a.created_at));
          }
        }
      }

      if (addedCount > 0) {
        showBriefMessage(`${addedCount} notes from ${hours}hr, ${authorCount} npubs`);
      } else {
        showBriefMessage(`No new notes in that ${hours}hr window`);
      }
    } catch (e) {
      if (__DEV__) console.log('[loadMore] failed:', e instanceof Error ? e.message : e);
      showBriefMessage('Load failed — try again');
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    isLoadingMore, activeTab, userPubkey, contacts, isFriendTab,
    isAllFollowsTab, isCustomFeedTab,
    userNotes, allFollowsNotes, customFeedNotes, friendNotes,
    activeCustomFeed, nostr, queryClient, limit, currentNotes,
    addCustomFeedNotes, showBriefMessage, fetchAndMergeUserNotes,
  ]);

  // ─── Load Newer ───────────────────────────────────────────────────────────

  const loadNewerNotes = useCallback(async () => {
    if (isLoadingNewer || !newestTimestamp) return;
    const requestTab = activeTab;

    setIsLoadingNewer(true);
    setFreshNoteIds(new Set());

    try {
      let newEvents: NostrEvent[] = [];

      if (isAllFollowsTab && contacts && contacts.length > 0) {
        setBatchProgress({ loaded: 0, total: 1 });
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: contacts,
          since: newestTimestamp + 1,
          limit,
        }], { signal: AbortSignal.timeout(15000) });
        setBatchProgress({ loaded: 1, total: 1 });

      } else if (isCustomFeedTab && activeCustomFeed) {
        if (activeCustomFeed.pubkeys.length > 0) {
          newEvents = await nostr.query([{
            kinds: [...FEED_KINDS],
            authors: activeCustomFeed.pubkeys,
            since: newestTimestamp + 1,
            limit,
          }], { signal: AbortSignal.timeout(15000) });
        }

      } else if (activeTab === 'me' && userPubkey) {
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: [userPubkey],
          since: newestTimestamp + 1,
          limit,
        }], { signal: AbortSignal.timeout(10000) });

      } else if (isFriendTab) {
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: [activeTab],
          since: newestTimestamp + 1,
          limit,
        }], { signal: AbortSignal.timeout(10000) });
      }

      setBatchProgress(null);

      // Also fetch user notes for the same window (for dovetailing)
      await fetchAndMergeUserNotes({ since: newestTimestamp + 1, limit });

      // Bail if user switched tabs while we were fetching
      if (activeTabRef.current !== requestTab) {
        if (__DEV__) console.log('[loadNewer] tab changed, discarding results');
        return;
      }

      const existingIds = new Set(currentNotes.map(n => n.id));
      const trulyNew = newEvents.filter(e => !existingIds.has(e.id));

      if (trulyNew.length > 0) {
        const sortedNew = trulyNew.sort((a, b) => b.created_at - a.created_at);

        // Gap detection & backfill
        const oldestNew = sortedNew[sortedNew.length - 1].created_at;
        const gapSeconds = oldestNew - (newestTimestamp ?? oldestNew);
        const GAP_THRESHOLD = 10 * 60; // 10 minutes

        if (gapSeconds > GAP_THRESHOLD && newestTimestamp) {
          if (__DEV__) console.log('[loadNewer] Gap detected:', Math.round(gapSeconds / 60), 'min — backfilling');
          try {
            let gapEvents: NostrEvent[] = [];
            const gapAuthors = isAllFollowsTab ? contacts ?? [] :
              isCustomFeedTab && activeCustomFeed ? activeCustomFeed.pubkeys :
              isFriendTab ? [activeTab] :
              activeTab === 'me' && userPubkey ? [userPubkey] : [];

            if (gapAuthors.length > 0) {
              gapEvents = await nostr.query([{
                kinds: [...FEED_KINDS],
                authors: gapAuthors,
                since: newestTimestamp + 1,
                until: oldestNew,
                limit: limit * 2,
              }], { signal: AbortSignal.timeout(15000) });
            }

            if (gapEvents.length > 0) {
              const gapNew = gapEvents.filter(e => !existingIds.has(e.id) && !sortedNew.some(n => n.id === e.id));
              if (gapNew.length > 0) {
                sortedNew.push(...gapNew);
                sortedNew.sort((a, b) => b.created_at - a.created_at);
                if (__DEV__) console.log('[loadNewer] Backfilled', gapNew.length, 'gap notes');
              }
            }
          } catch (err) {
            if (__DEV__) console.warn('[loadNewer] Gap backfill failed:', err);
          }
        }

        const newIds = sortedNew.map(n => n.id);
        setFreshNoteIds(prev => {
          const updated = new Set(prev);
          newIds.forEach(id => updated.add(id));
          return updated;
        });

        const newest = sortedNew.reduce((max, n) => n.created_at > max ? n.created_at : max, sortedNew[0].created_at);
        setNewestTimestamp(newest);
        setNewerNotes(prev => [...sortedNew, ...prev]);
        setLastFetchTime(Math.floor(Date.now() / 1000));
        showBriefMessage(`${sortedNew.length} new notes loaded`);
      } else {
        setLastFetchTime(Math.floor(Date.now() / 1000));
        showBriefMessage('No new notes found');
      }
    } catch (err) {
      if (__DEV__) console.error('[loadNewer] error:', err);
      showBriefMessage('Load failed — try again');
    } finally {
      setIsLoadingNewer(false);
    }
  }, [
    isLoadingNewer, newestTimestamp,
    isAllFollowsTab, isCustomFeedTab,
    activeTab, contacts, activeCustomFeed, userPubkey, isFriendTab,
    nostr, currentNotes, limit, showBriefMessage, fetchAndMergeUserNotes,
    setLastFetchTime, setNewerNotes, setNewestTimestamp,
  ]);

  // ─── Load More By Count ───────────────────────────────────────────────────
  // Fetches ~`count` notes older than the oldest visible note on this tab.
  // Ideal for FlatList onEndReached.

  const loadMoreByCount = useCallback(async (count: number) => {
    if (isLoadingMore || isLoadingNewer) return;
    const requestTab = activeTab;

    setIsLoadingMore(true);
    setLoadingMessage(`Loading ~${count} notes…`);

    try {
      // Also fetch newer notes if within default time window
      const now = Math.floor(Date.now() / 1000);
      const authorCount = contacts?.length ?? 0;
      const baseWindow = authorCount <= 500 ? 3600 : authorCount <= 1000 ? 1800 : 600;
      const defaultWindow = baseWindow * (_multiplier || 1);
      const curNewest = newestTimestampMap.current.get(activeTab) ?? null;

      if (curNewest && (now - curNewest) < defaultWindow && (now - curNewest) > 30) {
        let newerAuthors: string[] = [];
        if (activeTab === 'me' && userPubkey) {
          newerAuthors = [userPubkey];
        } else if (isAllFollowsTab && contacts && contacts.length > 0) {
          newerAuthors = contacts;
        } else if (isCustomFeedTab && activeCustomFeed) {
          newerAuthors = activeCustomFeed.pubkeys || [];
        } else if (isFriendTab) {
          newerAuthors = [activeTab];
        }
        if (newerAuthors.length > 0) {
          try {
            const newerEvents = await nostr.query([{
              kinds: [...FEED_KINDS],
              authors: newerAuthors,
              since: curNewest + 1,
              limit,
            }], { signal: AbortSignal.timeout(5000) });

            if (newerEvents.length > 0) {
              const existingNewerIds = new Set((newerNotesMap.current.get(activeTab) || []).map(n => n.id));
              const existingCurrentIds = new Set(currentNotes.map(n => n.id));
              const trulyNewer = newerEvents.filter(e => !existingNewerIds.has(e.id) && !existingCurrentIds.has(e.id));
              if (trulyNewer.length > 0) {
                const sorted = trulyNewer.sort((a, b) => b.created_at - a.created_at);
                setNewerNotes(prev => [...sorted, ...prev]);
                const newest = sorted[0].created_at;
                setNewestTimestamp(prev => (prev === null || newest > prev ? newest : prev));

                const newIds = sorted.map(n => n.id);
                setFreshNoteIds(prev => {
                  const updated = new Set(prev);
                  newIds.forEach(id => updated.add(id));
                  return updated;
                });
              }
            }
            await fetchAndMergeUserNotes({ since: curNewest + 1, limit });
          } catch {
            // Non-critical
          }
          setLastFetchTime(now);
        }
      }

      // Determine authors for this tab
      let authors: string[] = [];
      if (activeTab === 'me' && userPubkey) {
        authors = [userPubkey];
      } else if (isCustomFeedTab && activeCustomFeed) {
        authors = activeCustomFeed.pubkeys || [];
      } else if (isAllFollowsTab && contacts && contacts.length > 0) {
        authors = contacts;
      } else if (isFriendTab) {
        authors = [activeTab];
      }

      if (authors.length === 0) {
        showBriefMessage('No authors for this tab');
        setIsLoadingMore(false);
        setLoadingMessage(null);
        return;
      }

      // Determine cache key
      const userInContacts = contacts?.includes(userPubkey ?? '') ?? false;
      const allAuthorsCount = (contacts?.length ?? 0) + (userPubkey && !userInContacts ? 1 : 0);
      const followCacheKey = ['follow-notes-cache', allAuthorsCount > 0] as const;
      const userNotesKey = ['user-notes', userPubkey] as const;
      const customFeedKey = activeCustomFeed ? ['custom-feed-cache', activeCustomFeed.id, activeCustomFeed.pubkeys?.length ?? 0] as const : null;
      const cacheKey = (activeTab === 'me' && userPubkey) ? userNotesKey : (isCustomFeedTab && customFeedKey ? customFeedKey : followCacheKey);

      // Check cache first
      const existing = (queryClient.getQueryData(cacheKey) as NostrEvent[] | undefined) ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const authorSet = new Set(authors);
      const cachedEvents = existing.filter(e => authorSet.has(e.pubkey));

      // Always fetch `count` notes from relay
      const neededFromRelay = count;
      let fetchedEvents: NostrEvent[] = [];

      if (neededFromRelay > 0) {
        let until: number;
        if (existing.length === 0) {
          until = Math.floor(Date.now() / 1000);
        } else {
          const oldestInCache = existing[existing.length - 1].created_at;
          until = oldestInCache - 1;
        }

        const raw = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors,
          until,
          limit: neededFromRelay,
        }], { signal: AbortSignal.timeout(5000) });

        // Dedup
        const seen = new Set<string>();
        fetchedEvents = raw
          .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
          .sort((a, b) => b.created_at - a.created_at);

        if (fetchedEvents.length > neededFromRelay) {
          fetchedEvents = fetchedEvents.slice(0, neededFromRelay);
        }
      }

      // Also fetch user notes for the same window
      const untilForUser = existing.length > 0 ? existing[existing.length - 1].created_at - 1 : Math.floor(Date.now() / 1000);
      await fetchAndMergeUserNotes({ until: untilForUser, limit: count });

      // Bail if user switched tabs while we were fetching
      if (activeTabRef.current !== requestTab) {
        if (__DEV__) console.log('[loadMoreByCount] tab changed, discarding results');
        return;
      }

      // Combine: cached + newly fetched
      const allNewEvents = [...cachedEvents, ...fetchedEvents];
      const trulyNew = allNewEvents.filter(n => !existingIds.has(n.id));

      if (trulyNew.length > 0) {
        const merged = [...existing, ...trulyNew].sort((a, b) => b.created_at - a.created_at);
        queryClient.setQueryData(cacheKey, merged);
        if (activeTab === 'me' && onMeTabNotesLoaded) {
          onMeTabNotesLoaded(merged);
        }
      }

      if (trulyNew.length > 0) {
        showBriefMessage(`${trulyNew.length} more notes loaded`);
      } else {
        showBriefMessage('No older notes found');
      }
    } catch (err) {
      if (__DEV__) console.error('[loadMoreByCount] error:', err);
      showBriefMessage('Load failed — try again');
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    isLoadingMore, isLoadingNewer,
    isAllFollowsTab, isCustomFeedTab,
    activeTab, contacts, activeCustomFeed, userPubkey, isFriendTab,
    nostr, queryClient, limit, _multiplier, currentNotes,
    showBriefMessage, onMeTabNotesLoaded, fetchAndMergeUserNotes,
    setLastFetchTime, setNewerNotes, setNewestTimestamp,
  ]);

  return {
    hasMore,
    isLoadingMore,
    isLoadingNewer,
    loadingMessage,
    newerNotes,
    freshNoteIds,
    newestTimestamp,
    lastFetchTime,
    batchProgress,
    loadMoreNotes,
    loadMoreByCount,
    loadNewerNotes,
    setBatchProgress,
    hoursLoaded: hoursLoadedRef.current,
  };
}
