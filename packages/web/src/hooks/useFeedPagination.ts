/**
 * useFeedPagination — centralises "load older" and "load newer" logic that was
 * previously two 150-line useCallback blocks inside MultiColumnClient.
 *
 * It owns:
 *  - hasMore / isLoadingMore / isLoadingNewer
 *  - newerNotes (events prepended to the feed after a "load newer" call)
 *  - freshNoteIds (IDs highlighted for 90 s after being loaded)
 *  - newestTimestamp (tracks the leading edge for "since" queries)
 *  - batchProgress (shown while batched all-follows queries run)
 *  - loadingMessage (shown in the purple pill while loading, then briefly shows result)
 *
 * Callers supply the current notes for the active tab so that the hook can
 * derive timestamps and update the React-Query cache.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { type NostrEvent, NRelay1 } from '@nostrify/nostrify';
import { useNostr } from '@/hooks/useNostr';
import { useQueryClient } from '@tanstack/react-query';
import {
  batchFetchByAuthors,
  FEED_KINDS,
} from '@/lib/feedUtils';
import { debugLog, debugWarn, debugError } from '@/lib/debug';

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
  /** Note limit from useFeedLimit (60/12 based on viewport × multiplier) */
  limit: number;
  /** Feed multiplier (1x, 2x, 3x) */
  multiplier?: number;
  /** Pre-filtered notes currently displayed for the active tab (used for timestamp math) */
  currentNotes: NostrEvent[];
  /** Current notes from each feed data-source (for React-Query cache keys) */
  userNotes: NostrEvent[] | undefined;
  allFollowsNotes: NostrEvent[] | undefined;
  customFeedNotes: NostrEvent[] | undefined;
  friendNotes: NostrEvent[] | undefined;
  /** Add notes to custom feed cache (for count-based loading on custom feeds) */
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
  scrollTargetNoteId: string | null;
  clearScrollTarget: () => void;
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
  const [scrollTargetNoteId, setScrollTargetNoteId] = useState<string | null>(null);

  const [batchProgress, setBatchProgress] = useState<{ loaded: number; total: number } | null>(null);

  const messageClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Per-tab state: why useRef<Map> instead of useState ────────────────────
  //
  // useFeedPagination is mounted once for the lifetime of MultiColumnClient and
  // must preserve scroll position, newer notes, and timestamp anchors for EVERY
  // tab simultaneously — not just the active one.
  //
  // If we used useState for newerNotes we would have to store a Record<tabId, …>
  // and update it with setState, which causes a second render on every tab switch
  // even though no visible data changed. Worse, async callbacks that close over
  // a stale `activeTab` would overwrite the wrong tab's state.
  //
  // Instead:
  //   - Each per-tab value lives in a useRef<Map<tabId, value>>.
  //   - The map is mutated directly (no re-render from the write itself).
  //   - A single [, forceUpdate] = useState(0) counter is incremented to
  //     trigger re-render only when the currently active tab's derived values
  //     have actually changed. All async callbacks check `activeTabRef.current`
  //     before writing to the map, so a stale closure cannot corrupt another
  //     tab's data.
  //
  // This is an intentional departure from "pure React state". Do not convert
  // to useState without carefully reading all async paths in loadMoreNotes,
  // loadNewerNotes, and loadMoreByCount. The forceUpdate pattern is safe here
  // because useFeedPagination is a singleton hook used in a single, stable
  // component tree position.
  // ──────────────────────────────────────────────────────────────────────────
  const newerNotesMap = useRef(new Map<string, NostrEvent[]>());
  const newestTimestampMap = useRef(new Map<string, number>());
  const lastFetchTimeMap = useRef(new Map<string, number>());
  const hoursLoadedMap = useRef(new Map<string, number>());

  // Derive current tab's values from maps
  const newerNotes = newerNotesMap.current.get(activeTab) || [];
  const newestTimestamp = newestTimestampMap.current.get(activeTab) ?? null;
  const lastFetchTime = lastFetchTimeMap.current.get(activeTab) ?? null;
  const hoursLoadedRef = useRef(hoursLoadedMap.current.get(activeTab) || 0);

  // Helpers to update per-tab state (trigger re-render via a counter)
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

  // Derived tab-type flags (same logic as in MultiColumnClient)
  const isRelayTab = activeTab.startsWith('wss://') || activeTab.startsWith('ws://');
  const isCustomFeedTab = activeTab.startsWith('feed:');
  const isDiscoverTab = activeTab === 'discover';
  const isAllFollowsTab = activeTab === 'all-follows';
  const isRssTab = activeTab.startsWith('rss:');
  const isSavedTab = activeTab === 'saved';
  const isNotificationsTab = activeTab === 'notifications';
  const isFriendTab = !isRelayTab && !isCustomFeedTab && !isDiscoverTab && !isAllFollowsTab && !isRssTab && !isSavedTab && !isNotificationsTab && activeTab !== 'me';

  // Per-tab state is now preserved in Maps — no reset needed on tab change

  // Track newest timestamp from displayed notes — exclude own posts so that
  // 'me' notes injected via showOwnNotes don't skew the since-anchor for loadNewerNotes.
  // Also exclude RSS pseudo-events (pubkey 'rss-feed') since they represent article
  // publication dates, not Nostr relay fetch windows — including them would prevent
  // the pagination system from correctly fetching newer npub notes.
  // Exception: on the 'me' tab, include all notes since that's the user's own feed.
  useEffect(() => {
    if (currentNotes.length > 0) {
      // On 'me' tab, include all notes. On other tabs, exclude user's own notes and RSS.
      const notesToTrack = activeTab === 'me'
        ? currentNotes
        : currentNotes.filter(n => {
            if (n.pubkey === 'rss-feed') return false; // RSS items don't represent Nostr fetch window
            if (userPubkey && n.pubkey === userPubkey) return false; // own posts
            return true;
          });

      if (notesToTrack.length > 0) {
        const newest = notesToTrack.reduce((max, n) => n.created_at > max ? n.created_at : max, notesToTrack[0].created_at);
        setNewestTimestamp(prev => (prev === null || newest > prev ? newest : prev));
        setLastFetchTime(prev => prev ?? Math.floor(Date.now() / 1000));
      } else if (currentNotes.length > 0) {
        // Only RSS items present (no Nostr notes yet) — seed lastFetchTime so
        // autofetch and "Newer" button work to fetch actual Nostr notes.
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

  // Show a message on the pill briefly, then clear it
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
        // Merge into user-notes cache only — never pollute follow-notes-cache
        // so other tabs don't get notes outside their time window.
        const cached = (queryClient.getQueryData(userNotesKey) as NostrEvent[] | undefined) ?? [];
        const existingIds = new Set(cached.map(n => n.id));
        const trulyNew = myEvents.filter(n => !existingIds.has(n.id));
        if (trulyNew.length > 0) {
          queryClient.setQueryData(userNotesKey, [...cached, ...trulyNew].sort((a, b) => b.created_at - a.created_at));
        }
      }
    } catch {
      // Non-critical — tab notes still load fine
    }
  }, [showOwnNotes, userPubkey, activeTab, nostr, queryClient]);

  // When "include my notes" is toggled ON, immediately fetch user notes so they
  // appear in the feed without waiting for the next loadNewer/loadMoreByCount call.
  // Only fetch within the time window of currently visible notes — never beyond.
  const prevShowOwnNotes = useRef(showOwnNotes);
  useEffect(() => {
    if (showOwnNotes && !prevShowOwnNotes.current && userPubkey && activeTab !== 'me') {
      // Determine the time window from currently visible notes
      const notesFromOthers = currentNotes.filter(n => n.pubkey !== userPubkey);
      if (notesFromOthers.length > 0) {
        const oldest = notesFromOthers.reduce((min, n) => n.created_at < min ? n.created_at : min, notesFromOthers[0].created_at);
        fetchAndMergeUserNotes({ since: oldest, limit: 200 });
      }
      // If no notes visible yet, don't fetch — pagination will pick them up later
    }
    prevShowOwnNotes.current = showOwnNotes;
  }, [showOwnNotes, userPubkey, activeTab, fetchAndMergeUserNotes, currentNotes]);

  // ─── Load Older (pagination) ────────────────────────────────────────────────

  const loadMoreNotes = useCallback(async (hours: number) => {
    debugLog('[loadMore] hours:', hours, 'tab:', activeTab);
    if (isLoadingMore) return;
    const requestTab = activeTab;

    // Determine which cached data / query key to use
    let currentTabNotes: NostrEvent[] = [];

    if (activeTab === 'me') {
      currentTabNotes = userNotes || [];
    } else if (isAllFollowsTab) {
      currentTabNotes = allFollowsNotes || [];
    } else if (isCustomFeedTab && activeCustomFeed) {
      currentTabNotes = customFeedNotes || [];
    } else if (!isRelayTab && !isDiscoverTab && !isRssTab) {
      currentTabNotes = friendNotes || [];
    }

    // Match useFollowNotesCache allAuthors calculation
    const userInContacts = contacts?.includes(userPubkey ?? '') ?? false;
    const allAuthorsCount = (contacts?.length ?? 0) + (userPubkey && !userInContacts ? 1 : 0);
    const followCacheKey: unknown[] = ['follow-notes-cache', allAuthorsCount > 0];
    const userNotesKey = ['user-notes', userPubkey] as const;

    // Use currentNotes (actual visible notes) for oldest timestamp
    const visibleNotes = currentNotes.length > 0 ? currentNotes : currentTabNotes;
    
    // Oldest timestamp - if no notes, we need a different approach
    // We'll use the cumulative hours loaded as the anchor
    const hoursBackFromNow = hoursLoadedRef.current * 3600;
    const now = Math.floor(Date.now() / 1000);
    
    // Track if we're doubling (when no notes cached)
    let hoursToFetch = hours;
    let didDoubleFetch = false;
    
    // oldestTimestamp is: the end of what we've already loaded
    // If we have notes, use the oldest note as anchor
    // If we have no notes but have loaded X hours, anchor at (now - X hours)
    // If never loaded anything, fetch double the hours and anchor at "now"
    let anchorTimestamp: number;
    if (visibleNotes.length > 0) {
      const notesFromOthers = visibleNotes.filter(n => n.pubkey !== userPubkey);
      anchorTimestamp = notesFromOthers.length > 0
        ? notesFromOthers.reduce((min, n) => n.created_at < min ? n.created_at : min, notesFromOthers[0].created_at)
        : visibleNotes.reduce((min, n) => n.created_at < min ? n.created_at : min, visibleNotes[0].created_at);
    } else if (hoursBackFromNow > 0) {
      // No notes but we've loaded X hours before - anchor at that boundary
      anchorTimestamp = now - hoursBackFromNow;
    } else {
      // Never loaded anything - fetch double hours from now
      hoursToFetch = hours * 2;
      didDoubleFetch = true;
      anchorTimestamp = now;
    }

    // Determine author count based on tab type
    let authorCount = contacts?.length ?? 0;
    if (isCustomFeedTab && activeCustomFeed) {
      authorCount = activeCustomFeed.pubkeys?.length ?? 0;
    }
    
    // hours already includes multiplier from StatusBar, don't multiply again
    setIsLoadingMore(true);
    if (visibleNotes.length === 0) {
      // No cached notes — tell the user we're fetching
      const fetchHours = didDoubleFetch ? hoursToFetch : hours;
      setLoadingMessage(`No notes in cache — fetching ${fetchHours} hours…`);
    }
    // If we already have cached notes showing, don't block with a message —
    // the fetch runs quietly in the background.

    hoursLoadedRef.current += hours;
    hoursLoadedMap.current.set(activeTab, hoursLoadedRef.current);

    // Calculate since/until based on anchorTimestamp
    const until = anchorTimestamp - 1;
    const since = until - (hoursToFetch * 3600);

    debugLog('[loadMore] since:', new Date(since * 1000).toISOString(), 'until:', new Date(until * 1000).toISOString());

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
        const hasRss = (activeCustomFeed.rssUrls?.length ?? 0) > 0;
        if (hasPubkeys) {
          newEvents = await nostr.query([{
            kinds: [...FEED_KINDS],
            authors: activeCustomFeed.pubkeys,
            since,
            until,
            limit,
          }], { signal });
        } else if (hasRss) {
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

      debugLog('[loadMore] got', newEvents.length, 'events');

      // Also fetch user notes for the same window (for dovetailing)
      await fetchAndMergeUserNotes({ since, until, limit });

      // Bail if user switched tabs while we were fetching
      if (activeTabRef.current !== requestTab) {
        debugLog('[loadMore] tab changed, discarding results');
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
        // Scroll target = newest of the newly loaded batch
        const newest = newEvents.reduce((max, n) => n.created_at > max.created_at ? n : max, newEvents[0]);
        setScrollTargetNoteId(newest.id);
        // Calculate actual hours from now until oldest note, then add hours clicked
        const nowSeconds = Math.floor(Date.now() / 1000);
        const notesToCheck = currentNotes.length > 0 ? currentNotes : currentTabNotes;
        let actualHours = hours;
        if (notesToCheck.length > 0) {
          const notesFromOthers = notesToCheck.filter(n => n.pubkey !== userPubkey);
          const oldestNote = notesFromOthers.length > 0
            ? notesFromOthers.reduce((min, n) => n.created_at < min ? n.created_at : min, notesFromOthers[0].created_at)
            : notesToCheck.reduce((min, n) => n.created_at < min ? n.created_at : min, notesToCheck[0].created_at);
          const hoursFromOldest = (nowSeconds - oldestNote) / 3600;
          actualHours = Math.round(hoursFromOldest) + hours;
        }
        if (isCustomFeedTab) {
          showBriefMessage(`${addedCount} notes loaded: ${actualHours} hours now displayed`);
        } else {
          showBriefMessage(`${addedCount} notes from ${hours}hr, ${authorCount} npubs`);
        }
      } else {
        if (isCustomFeedTab) {
          showBriefMessage(`no notes for these ${authorCount} npubs within time window`);
        } else {
          showBriefMessage(`No new notes in that ${hours}hr window`);
        }
      }
    } catch (e) {
      debugLog('[loadMore] failed:', e instanceof Error ? e.message : e);
      showBriefMessage('Load failed — try again');
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    isLoadingMore, activeTab, userPubkey, contacts, isFriendTab,
    isAllFollowsTab, isCustomFeedTab, isRelayTab, isDiscoverTab, isRssTab,
    userNotes, allFollowsNotes, customFeedNotes, friendNotes,
    activeCustomFeed, nostr, queryClient, limit, currentNotes,
    addCustomFeedNotes, showBriefMessage, fetchAndMergeUserNotes,
  ]);

  // ─── Load Newer ─────────────────────────────────────────────────────────────

  const loadNewerNotes = useCallback(async () => {
    if (isLoadingNewer) return;
    // Use newestTimestamp if available, otherwise fall back to "last 2 hours"
    // so feeds with only RSS items can still fetch Nostr notes.
    const sinceTs = newestTimestamp ?? (Math.floor(Date.now() / 1000) - 7200);
    const requestTab = activeTab;

    let _authorCount = contacts?.length ?? 0;
    if (isCustomFeedTab && activeCustomFeed) {
      _authorCount = activeCustomFeed.pubkeys?.length ?? 0;
    }
    setIsLoadingNewer(true);
    // Clear previous fresh highlights — new fetch replaces them
    setFreshNoteIds(new Set());
    // No blocking message — newer notes load quietly in the background.

    try {
      let newEvents: NostrEvent[] = [];

      if (isAllFollowsTab && contacts && contacts.length > 0) {
        setBatchProgress({ loaded: 0, total: 1 });
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: contacts,
          since: sinceTs + 1,
          limit,
        }], { signal: AbortSignal.timeout(15000) });
        setBatchProgress({ loaded: 1, total: 1 });

      } else if (isRelayTab) {
        const relay = new NRelay1(activeTab, { backoff: false });
        try {
          for await (const msg of relay.req([{
            kinds: [1, 30023],
            since: sinceTs + 1,
            limit,
          }])) {
            if (msg[0] === 'EVENT') newEvents.push(msg[2] as NostrEvent);
            else if (msg[0] === 'EOSE') break;
          }
        } finally {
          relay.close();
        }

      } else if (isCustomFeedTab && activeCustomFeed) {
        if (activeCustomFeed.pubkeys.length > 0) {
          newEvents = await nostr.query([{
            kinds: [...FEED_KINDS],
            authors: activeCustomFeed.pubkeys,
            since: sinceTs + 1,
            limit,
          }], { signal: AbortSignal.timeout(15000) });
        }

      } else if (activeTab === 'me' && userPubkey) {
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: [userPubkey],
          since: sinceTs + 1,
          limit,
        }], { signal: AbortSignal.timeout(10000) });

      } else if (isFriendTab) {
        newEvents = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: [activeTab],
          since: sinceTs + 1,
          limit,
        }], { signal: AbortSignal.timeout(10000) });
      }

      setBatchProgress(null);

      // Also fetch user notes for the same window (for dovetailing)
      await fetchAndMergeUserNotes({ since: sinceTs + 1, limit });

      // Bail if user switched tabs while we were fetching
      if (activeTabRef.current !== requestTab) {
        debugLog('[loadNewer] tab changed, discarding results');
        return;
      }

      const existingIds = new Set(currentNotes.map(n => n.id));
      const trulyNew = newEvents.filter(e => !existingIds.has(e.id));

      if (trulyNew.length > 0) {
        const sortedNew = trulyNew.sort((a, b) => b.created_at - a.created_at);

        // ─── Gap detection & backfill ───────────────────────────────────
        // If the oldest newly fetched note is much newer than our anchor,
        // there's likely a gap (e.g. relay connections were dead for hours).
        // Backfill the gap so the feed is continuous.
        const oldestNew = sortedNew[sortedNew.length - 1].created_at;
        const gapSeconds = oldestNew - (newestTimestamp ?? oldestNew);
        const GAP_THRESHOLD = 10 * 60; // 10 minutes

        if (gapSeconds > GAP_THRESHOLD && newestTimestamp) {
          debugLog('[loadNewer] Gap detected:', Math.round(gapSeconds / 60), 'min — backfilling');
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
                since: sinceTs + 1,
                until: oldestNew,
                limit: limit * 2,
              }], { signal: AbortSignal.timeout(15000) });
            }

            if (gapEvents.length > 0) {
              const gapNew = gapEvents.filter(e => !existingIds.has(e.id) && !sortedNew.some(n => n.id === e.id));
              if (gapNew.length > 0) {
                sortedNew.push(...gapNew);
                sortedNew.sort((a, b) => b.created_at - a.created_at);
                debugLog('[loadNewer] Backfilled', gapNew.length, 'gap notes');
              }
            }
          } catch (err) {
            debugWarn('[loadNewer] Gap backfill failed:', err);
            // Non-fatal — continue with what we have
          }
        }
        // ────────────────────────────────────────────────────────────────

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
        // Scroll to oldest newly loaded note (bottom of the new batch)
        const oldest = sortedNew[sortedNew.length - 1];
        setScrollTargetNoteId(oldest.id);
        showBriefMessage(`${sortedNew.length} new notes loaded`);
      } else {
        // No new notes found — only update lastFetchTime (for the UI indicator).
        // Do NOT advance newestTimestamp: if the fetch returned empty because relay
        // connections were dead (e.g. after idle), advancing the timestamp would
        // skip the entire gap and make those notes unreachable on the next fetch.
        setLastFetchTime(Math.floor(Date.now() / 1000));
        showBriefMessage('No new notes found');
      }
    } catch (err) {
      debugError('[loadNewer] error:', err);
      showBriefMessage('Load failed — try again');
    } finally {
      setIsLoadingNewer(false);
    }
  }, [
    isLoadingNewer, newestTimestamp,
    isAllFollowsTab, isRelayTab, isCustomFeedTab,
    activeTab, contacts, activeCustomFeed, userPubkey, isFriendTab,
    nostr, currentNotes, limit, showBriefMessage, fetchAndMergeUserNotes,
    setLastFetchTime, setNewerNotes, setNewestTimestamp,
  ]);

  // ─── Load More By Count ─────────────────────────────────────────────────────
  // Fetches ~`count` notes older than the oldest visible note on this tab.
  // 1. First checks IndexedDB/cache for requested amount
  // 2. If cache doesn't have enough, requests from relay
  // 3. If relay returns more than requested, slices to exactly count

  const loadMoreByCount = useCallback(async (count: number) => {
    if (isLoadingMore || isLoadingNewer) {
      showBriefMessage('Loading in progress — try again shortly');
      return;
    }
    const requestTab = activeTab;

    setIsLoadingMore(true);
    setLoadingMessage(`Loading ~${count} notes…`);

    try {
      // ── Also fetch newer notes if within default time window ──────────
      const now = Math.floor(Date.now() / 1000);
      const authorCount = contacts?.length ?? 0;
      const baseWindow = authorCount <= 500 ? 3600 : authorCount <= 1000 ? 1800 : 600;
      const defaultWindow = baseWindow * (_multiplier || 1);
      const curNewest = newestTimestampMap.current.get(activeTab) ?? null;

      if (curNewest && (now - curNewest) < defaultWindow && (now - curNewest) > 30) {
        // Gap is within the default window — backfill newer notes too
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
              // Merge into newerNotes for display
              const existingNewerIds = new Set((newerNotesMap.current.get(activeTab) || []).map(n => n.id));
              const existingCurrentIds = new Set(currentNotes.map(n => n.id));
              const trulyNewer = newerEvents.filter(e => !existingNewerIds.has(e.id) && !existingCurrentIds.has(e.id));
              if (trulyNewer.length > 0) {
                const sorted = trulyNewer.sort((a, b) => b.created_at - a.created_at);
                setNewerNotes(prev => [...sorted, ...prev]);
                const newest = sorted[0].created_at;
                setNewestTimestamp(prev => (prev === null || newest > prev ? newest : prev));

                // Persist to IndexedDB so they survive page refresh
                import('@/lib/notesCache').then(({ mergeNotesToCache }) => {
                  mergeNotesToCache(sorted);
                });

                // Mark as fresh
                const newIds = sorted.map(n => n.id);
                setFreshNoteIds(prev => {
                  const updated = new Set(prev);
                  newIds.forEach(id => updated.add(id));
                  return updated;
                });
              }
            }
            // Also fetch own newer notes for dovetailing
            await fetchAndMergeUserNotes({ since: curNewest + 1, limit });
          } catch {
            // Non-critical — older notes still load
          }
          setLastFetchTime(now);
        }
      }

      // ── Determine authors for this tab ─────────────────────────────────
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

      debugLog('[loadMoreByCount] tab:', activeTab, 'authors:', authors.length, 'count:', count);

      if (authors.length === 0) {
        showBriefMessage('No authors for this tab');
        setIsLoadingMore(false);
        setLoadingMessage(null);
        return;
      }

      // ── Determine cache key ───────────────────────────────────────────
      const userInContacts = contacts?.includes(userPubkey ?? '') ?? false;
      const allAuthorsCount = (contacts?.length ?? 0) + (userPubkey && !userInContacts ? 1 : 0);
      const followCacheKey = ['follow-notes-cache', allAuthorsCount > 0] as const;
      const userNotesKey = ['user-notes', userPubkey] as const;
      const customFeedKey = activeCustomFeed ? ['custom-feed-cache', activeCustomFeed.id, activeCustomFeed.pubkeys?.length ?? 0] as const : null;
      const cacheKey = (activeTab === 'me' && userPubkey) ? userNotesKey : (isCustomFeedTab && customFeedKey ? customFeedKey : followCacheKey);

      // ── Check cache first ──────────────────────────────────────────────
      const existing = (queryClient.getQueryData(cacheKey) as NostrEvent[] | undefined) ?? [];
      const existingIds = new Set(existing.map(e => e.id));
      const authorSet = new Set(authors);

      // Get cached events from these authors (all of them, not just older than visible)
      const cachedEvents = existing.filter(e => authorSet.has(e.pubkey));

      const cachedCount = cachedEvents.length;
      debugLog('[loadMoreByCount] cached events from authors:', cachedCount);

      // Always fetch `count` notes from relay (using oldest cached note as anchor for pagination)
      // Cache is only used for deduplication, not to limit the fetch count
      const neededFromRelay = count;

      let fetchedEvents: NostrEvent[] = [];

      if (neededFromRelay > 0) {
        // ── Determine `until` (upper bound) ────────────────────────────────
        // Use the OLDEST note from the full cache, not just visible notes
        // This ensures we get notes older than what we've already fetched
        let until: number;
        if (existing.length === 0) {
          until = Math.floor(Date.now() / 1000);
          debugLog('[loadMoreByCount] No cached notes, fetching most recent');
        } else {
        // Get the oldest note from the cache (cache is sorted newest-first, so take last)
        const oldestInCache = existing[existing.length - 1].created_at;
        until = oldestInCache - 1;
        debugLog('[loadMoreByCount] oldest in cache:', new Date(oldestInCache * 1000).toISOString(), 'until:', new Date(until * 1000).toISOString());
        }

        // ── Fetch from relay ─────────────────────────────────────────────
        debugLog(`[loadMoreByCount] query until: ${new Date(until * 1000).toISOString()}  limit: ${neededFromRelay}`);
        
        // Use simple timeout - reqRouter will handle relay routing (author outbox + user relays + fallbacks)
        const raw = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors,
          until,
          limit: neededFromRelay,
        }], { signal: AbortSignal.timeout(5000) });

        // Dedup (pool may return duplicates from multiple relays)
        const seen = new Set<string>();
        fetchedEvents = raw
          .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
          .sort((a, b) => b.created_at - a.created_at);

        debugLog('[loadMoreByCount] fetched from relay:', fetchedEvents.length, 'notes');

        // Slice to exactly what was requested if relay returned more
        if (fetchedEvents.length > neededFromRelay) {
          fetchedEvents = fetchedEvents.slice(0, neededFromRelay);
          debugLog('[loadMoreByCount] sliced to:', fetchedEvents.length, 'notes');
        }
      }

      // Also fetch user notes for the same window (for dovetailing)
      const untilForUser = existing.length > 0 ? existing[existing.length - 1].created_at - 1 : Math.floor(Date.now() / 1000);
      await fetchAndMergeUserNotes({ until: untilForUser, limit: count });

      // Bail if user switched tabs while we were fetching
      if (activeTabRef.current !== requestTab) {
        debugLog('[loadMoreByCount] tab changed, discarding results');
        return;
      }

      // Combine: cached + newly fetched, up to count total
      const allNewEvents = [...cachedEvents, ...fetchedEvents];
      const trulyNew = allNewEvents.filter(n => !existingIds.has(n.id));

      if (trulyNew.length > 0) {
        const merged = [...existing, ...trulyNew].sort((a, b) => b.created_at - a.created_at);
        queryClient.setQueryData(cacheKey, merged);
        // Also persist to IndexedDB memCache so getFilteredByPubkeys picks them up
        // and they survive page refresh
        import('@/lib/notesCache').then(({ mergeNotesToCache }) => {
          mergeNotesToCache(trulyNew);
        });
        // For 'me' tab: notify parent so userNotes state re-renders immediately
        if (activeTab === 'me' && onMeTabNotesLoaded) {
          onMeTabNotesLoaded(merged);
        }
      }

      if (trulyNew.length > 0) {
        // Scroll target = newest of the newly loaded batch
        const newest = trulyNew.reduce((max, n) => n.created_at > max.created_at ? n : max, trulyNew[0]);
        setScrollTargetNoteId(newest.id);
        showBriefMessage(`${trulyNew.length} more notes loaded`);
      } else {
        showBriefMessage('No older notes found');
      }
    } catch (err) {
      debugError('[loadMoreByCount] error:', err);
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
    scrollTargetNoteId,
    clearScrollTarget: useCallback(() => setScrollTargetNoteId(null), []),
    loadMoreNotes,
    loadMoreByCount,
    loadNewerNotes,
    setBatchProgress,
    hoursLoaded: hoursLoadedRef.current,
  };
}
