import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
} from 'react-native';
import { HashtagActionContext } from '../contexts/hashtagAction';
import { DeletedAuthorsContext } from '../contexts/deletedAuthors';
import { useDeletedAuthors } from '../hooks/useDeletedAuthors';
import type { FlatList as FlatListType } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useFeed, useContacts, useFeedLoadMore } from '../hooks/useFeed';
import { FEED_PAGE_SIZE_MOBILE } from '@core/feedConstants';
import { bumpQueryEpoch } from '@core/queryGovernor';
// Note classification comes from @core — these were re-implemented locally here,
// and the copies had silently fallen behind: they missed a dozen video URL
// patterns, the ambiguous-CDN image heuristic, and NIP-25 marked-e-tag reaction
// targeting, so the same note could land in different filter chips on mobile
// than on web. Import the canonical versions so there is one classifier.
import {
  hashtagFeedVerdict,
  getNoteCategories,
  computeNoteKindStats,
  computeHashtagCounts,
  noteMatchesHashtags,
  noteMatchesKindFilters,
} from '@core/noteCategories';
import { useBulkAuthors } from '../hooks/useAuthor';
import { useNip65Relays } from '../hooks/useNip65Relays';
import { useMuteList } from '../hooks/useMuteList';
import { useBookmarks } from '../hooks/useBookmarks';
import { useCollapsedNotes } from '../hooks/useCollapsedNotes';
import { usePinnedNotes } from '../hooks/usePinnedNotes';
import { useAuth } from '../lib/AuthContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { usePlatformStorage } from '../hooks/usePlatformStorage';
import { useAutoFetch } from '../hooks/useAutoFetch';
import { useUnresolvedRetry } from '../hooks/useUnresolvedRetry';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { useCustomFeedNotes } from '../hooks/useCustomFeedNotes';
import { useFeedLimit } from '../hooks/useFeedLimit';
import { NoteCard } from '../components/NoteCard';
import { FeedFilters } from '../components/FeedFilters';
import { ContentFilters } from '../components/ContentFilters';
import { CorkboardBuilderModal, type CorkboardDraft } from '../components/CorkboardBuilderModal';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { getCachedEvent } from '../lib/fetchEvent';
import {
  noteMatchesContentFilters,
  hasActiveContentFilters as hasActiveContentFiltersFor,
  type ContentFilterConfig,
  type ContentFilterKey,
} from '@core/contentFilters';
import type { KindFilter } from '../components/NoteKindToggles';
import { ProfileModalProvider } from '../components/ProfileModal';
import { DeepLinkHandler } from '../components/DeepLinkHandler';
import { ComposeScreen } from './ComposeScreen';
import { ProfileScreen } from './ProfileScreen';
import { ThreadScreen } from './ThreadScreen';

// ============================================================================
// Custom feed type (matches web's CustomFeed interface)
// ============================================================================

interface CustomFeed {
  id: string;
  title: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
  hashtags?: string[];
}

// ============================================================================
// Tab types
// ============================================================================

type FeedTab = 'following' | 'global' | `feed:${string}`;

// Map note-category names → KindFilter slugs. Module-scope so the useMemo dep
// array can stay stable across renders.
const CATEGORY_TO_FILTER: Readonly<Record<string, KindFilter>> = {
  shortNotes: 'posts', replies: 'replies', longForm: 'articles',
  videos: 'videos', images: 'images', reposts: 'reposts', reactions: 'reactions',
  highlights: 'highlights', recipes: 'recipes', other: 'posts',
};

/** Everything off — nothing hidden, no exceptions needed. Module scope so
 *  "clear filters" resets to the same object identity it started with. */
const DEFAULT_CONTENT_FILTERS: ContentFilterConfig = {
  hideMinChars: 0,
  hideOnlyEmoji: false,
  hideOnlyMedia: false,
  hideOnlyLinks: false,
  hideMarkdown: false,
  hideExactText: '',
  allowPV: false,
  allowGM: false,
  allowGN: false,
  allowEyes: false,
  allow100: false,
};

/**
 * Hoisted out of the render body. As an inline arrow it was a NEW component
 * type on every HomeScreen render, so React unmounted and remounted every
 * separator in the list each time — for a spacer view, on every scroll-driven
 * state change.
 */
function NoteSeparator() {
  return <View style={{ height: 8 }} />;
}

// ============================================================================
// HomeScreen
// ============================================================================

export function HomeScreen() {
  const { pubkey } = useAuth();
  const { data: contacts } = useContacts(pubkey ?? undefined);
  const { fetchRelaysForMultiple } = useNip65Relays();
  const { prefetchFromNotes } = useBulkAuthors();
  const { mutedPubkeys } = useMuteList();
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const { isDismissed, isCollapsed, isCollapsedThisSession, dismissedThreadRootSet } = useCollapsedNotes();
  // Pin hook runs once per screen; the set + toggler are threaded into each card.
  const { pinnedSet, togglePin } = usePinnedNotes();

  // Fresh-note highlighting (parity with web's freshNoteIds). Mobile refetches
  // the whole list, so we track a per-tab newest-created_at baseline and mark
  // anything newer than it as fresh — immune to older notes pulled by load-more,
  // unlike an id diff. Reset on tab change so entering a board doesn't flash.
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const newestSeenRef = useRef<number | null>(null);
  const prevFreshSizeRef = useRef(0);
  const { limit } = useFeedLimit();

  // ── UI state ────────────────────────────────────────────────────────────────
  const [composing, setComposing] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<string | null>(null);
  const [viewingThread, setViewingThread] = useState<string | null>(null);
  // Note to auto-target the reply composer at when opening a thread via Comment.
  const [threadAutoReply, setThreadAutoReply] = useState<NostrEvent | null>(null);
  const flatListRef = useRef<FlatListType<NostrEvent>>(null);

  // ── Tab / feed switching ────────────────────────────────────────────────────
  // `corkboard:active-tab`, not the old mobile-only `home:active-tab`: the
  // latter is in neither PER_USER_KEYS nor BACKED_UP_KEYS, so the selected board
  // leaked across account switches (account B opened on account A's corkboard,
  // whose id B may not even own) and was never restored from a backup. Same key
  // web uses, so the selection now travels with the account.
  const [activeTab, setActiveTab] = useLocalStorage<FeedTab>(STORAGE_KEYS.ACTIVE_TAB, 'following');
  const [customFeeds, setCustomFeeds] = useLocalStorage<CustomFeed[]>('nostr-custom-feeds', []);

  // Corkboard builder (create/edit a board from npubs/#hashtags/relays/RSS).
  const [builderVisible, setBuilderVisible] = useState(false);
  const [editingFeed, setEditingFeed] = useState<CustomFeed | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const openNewBoard = useCallback(() => { setEditingFeed(null); setBuilderKey(k => k + 1); setBuilderVisible(true); }, []);
  const openEditBoard = useCallback((feed: CustomFeed) => { setEditingFeed(feed); setBuilderKey(k => k + 1); setBuilderVisible(true); }, []);
  const handleSaveBoard = useCallback((draft: CorkboardDraft) => {
    setCustomFeeds(prev => (prev.some(f => f.id === draft.id)
      ? prev.map(f => (f.id === draft.id ? draft : f))
      : [...prev, draft]));
    setActiveTab(`feed:${draft.id}`);
  }, [setCustomFeeds, setActiveTab]);
  const handleDeleteBoard = useCallback((id: string) => {
    setCustomFeeds(prev => prev.filter(f => f.id !== id));
    setActiveTab(cur => (cur === `feed:${id}` ? 'following' : cur));
  }, [setCustomFeeds, setActiveTab]);

  // Hashtag → "open in a new corkboard?" prompt (parity with web). Deeply-nested
  // NoteContent requests this via HashtagActionContext; we confirm, then create
  // (or reuse) a hashtag-filtered corkboard and switch to it.
  const handleHashtagPress = useCallback((tag: string) => {
    const norm = tag.replace(/^#/, '').toLowerCase();
    Alert.alert(
      `Open #${norm} in a new corkboard?`,
      `This creates a corkboard that shows notes tagged #${norm}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open corkboard',
          onPress: () => {
            const existing = customFeeds.find(f =>
              f.hashtags?.length === 1 && f.hashtags[0] === norm &&
              f.pubkeys.length === 0 && f.rssUrls.length === 0,
            );
            if (existing) { setActiveTab(`feed:${existing.id}`); return; }
            const newFeed: CustomFeed = {
              id: Date.now().toString(),
              title: `#${norm}`,
              pubkeys: [], relays: [], rssUrls: [], hashtags: [norm],
            };
            setCustomFeeds(prev => [...prev, newFeed]);
            setActiveTab(`feed:${newFeed.id}`);
          },
        },
      ],
    );
  }, [customFeeds, setCustomFeeds, setActiveTab]);
  const hashtagActionValue = useMemo(() => ({ onHashtagClick: handleHashtagPress }), [handleHashtagPress]);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
  // kindFilters holds the HIDDEN kinds; default hides reactions (all others shown).
  const [kindFilters, setKindFilters] = useState<Set<KindFilter>>(new Set(['reactions']));
  const [filterMode, setFilterMode] = useState<'any' | 'strict'>('any');
  const [hashtagFilters, setHashtagFilters] = useState<Set<string>>(new Set());
  // Content filters ("Hide notes with: …"). The panel existed on mobile but
  // nothing consumed it, so every control in it was inert; it now runs the same
  // @core predicate the web feed does.
  const [contentFilterConfig, setContentFilterConfig] = useState<ContentFilterConfig>(DEFAULT_CONTENT_FILTERS);
  const handleContentFilterChange = useCallback((key: ContentFilterKey, value: number | boolean | string) => {
    setContentFilterConfig(prev => ({ ...prev, [key]: value }));
  }, []);
  // The input stays bound to the raw config so typing feels instant; the FEED
  // reads a debounced copy. Every keystroke otherwise re-ran the whole pipeline
  // — classify, filter, recount hashtags — across every loaded note. Built from
  // the primitive rather than by spreading contentFilterConfig, whose identity
  // changes on each keystroke and would defeat the debounce. (Parity with web.)
  const debouncedHideExactText = useDebouncedValue(contentFilterConfig.hideExactText, 250);
  const {
    hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks, hideMarkdown,
    allowPV, allowGM, allowGN, allowEyes, allow100,
  } = contentFilterConfig;
  const feedContentFilterConfig = useMemo<ContentFilterConfig>(() => ({
    hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks, hideMarkdown,
    hideExactText: debouncedHideExactText,
    allowPV, allowGM, allowGN, allowEyes, allow100,
  }), [hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks, hideMarkdown, debouncedHideExactText, allowPV, allowGM, allowGN, allowEyes, allow100]);
  const hasContentFilters = hasActiveContentFiltersFor(feedContentFilterConfig);

  // ── Following feed ──────────────────────────────────────────────────────────
  const authors = pubkey && contacts && contacts.length > 0 ? contacts : [];
  const isFollowingTab = activeTab === 'following';
  const isGlobalTab = activeTab === 'global';
  // Following = the user's contacts; Global = unrestricted (no authors), which
  // also gives the two tabs distinct react-query cache keys in useFeed.
  const feedAuthors = isFollowingTab ? authors : [];
  const { data: rawFollowEvents, isLoading: followLoading, isError: followError, refetch: followRefetch, isFetching: followFetching } =
    useFeed(feedAuthors);
  // Pagination — fetches older notes when the list nears its end. The iteration
  // checks isDismissed so the visible list actually grows by `count` even when
  // a batch is dominated by previously-dismissed notes.
  const { loadMoreByCount, isLoading: isLoadingMore } = useFeedLoadMore({
    authors: feedAuthors,
    isDismissed,
  });

  // ── Custom feed ─────────────────────────────────────────────────────────────
  const activeFeedId = activeTab.startsWith('feed:') ? activeTab.slice(5) : null;
  const activeCustomFeed = useMemo(
    () => customFeeds.find(f => f.id === activeFeedId) ?? null,
    [customFeeds, activeFeedId],
  );
  const customFeedDef = useMemo(() => {
    if (!activeCustomFeed) return null;
    return {
      id: activeCustomFeed.id,
      pubkeys: activeCustomFeed.pubkeys,
      relays: activeCustomFeed.relays,
      rssUrls: activeCustomFeed.rssUrls,
      hashtags: activeCustomFeed.hashtags ?? [],
    };
  }, [activeCustomFeed]);

  const {
    notes: customNotes,
    isLoading: customLoading,
    refresh: customRefresh,
    loadMore: customLoadMore,
  } = useCustomFeedNotes({
    feed: customFeedDef,
    isActive: !!activeFeedId,
    limit,
    multiplier: 1,
    ensureRelays: fetchRelaysForMultiple, // outbox pass: discover corkboard authors' relays first
  });
  const [customLoadingMore, setCustomLoadingMore] = useState(false);

  // ── Pick the right data for the active tab ──────────────────────────────────
  const isCustomTab = !!activeFeedId;
  // For a corkboard, reconcile its own fetch with the follows feed for its
  // members, so notes visible on the follows tab also appear here (dismiss is
  // shared by note id, so they stay consistent). Parity with web corkboardNotes.
  const rawEvents = useMemo(() => {
    if (!isCustomTab) return rawFollowEvents;
    const feedPubkeys = new Set(activeCustomFeed?.pubkeys ?? []);
    const fromFollow = (rawFollowEvents ?? []).filter(e => feedPubkeys.has(e.pubkey));
    const seen = new Set<string>();
    const out: NostrEvent[] = [];
    for (const e of [...(customNotes ?? []), ...fromFollow]) {
      if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
    }
    return out;
  }, [isCustomTab, rawFollowEvents, customNotes, activeCustomFeed?.pubkeys]);
  const isLoading = isCustomTab ? customLoading : followLoading;
  const isError = isCustomTab ? false : followError;
  const isFetching = isCustomTab ? customLoading : followFetching;
  const refetch = isCustomTab ? customRefresh : followRefetch;

  // ── Autofetch ───────────────────────────────────────────────────────────────
  // Periodic background refresh, matching web. Reads the same two synced storage
  // keys web does, so a user who turned autofetch on for small screens there
  // gets it here too. Phones are always the "small screen" case, hence
  // AUTOFETCH_SMALL. Foreground/in-flight gating lives in the hook.
  const [autofetchEnabled] = usePlatformStorage<boolean>(STORAGE_KEYS.AUTOFETCH_SMALL, false);
  const [autofetchIntervalSecs] = usePlatformStorage<number>(STORAGE_KEYS.AUTOFETCH_INTERVAL_SECS, 120);
  // Opt-in: jump to the top when new notes arrive (pairs with fresh highlighting).
  const [autoScrollTop] = usePlatformStorage<boolean>(STORAGE_KEYS.AUTO_SCROLL_TOP, false);
  // Fetching new notes is also the right moment to re-attempt anything on
  // screen that never resolved — whatever was wrong has usually passed by then.
  // The sweep's own guards (threshold, in-flight, interval, backgrounded)
  // decide whether it does anything, so calling it on every fetch is safe.
  const { sweep: sweepUnresolved } = useUnresolvedRetry();
  const loadNewerAndRetry = useCallback(() => {
    void refetch();
    sweepUnresolved();
  }, [refetch, sweepUnresolved]);

  useAutoFetch({
    enabled: !!autofetchEnabled,
    intervalSecs: autofetchIntervalSecs,
    activeTab,
    isLoadingAny: isFetching || isLoadingMore || customLoadingMore,
    loadNewer: loadNewerAndRetry,
  });

  // ── Mute + deduplicate ──────────────────────────────────────────────────────
  const { events, eventLookup } = useMemo((): { events: NostrEvent[] | undefined; eventLookup: Map<string, NostrEvent> | undefined } => {
    if (!rawEvents) return { events: rawEvents, eventLookup: undefined };
    let filtered = mutedPubkeys.size > 0
      ? rawEvents.filter(e => !mutedPubkeys.has(e.pubkey))
      : rawEvents;

    // Lookup for resolving reaction/repost targets, built BEFORE dedup the way
    // web builds it. Dedup keeps only one of {repost, original}, so a lookup
    // built afterwards is missing exactly the originals reposts point at — the
    // ones the text filter and the classifier need to read.
    const lookup = new Map(filtered.map(e => [e.id, e]));

    // Standalone "content" kinds — notes that render on their own. A reaction/zap
    // card is suppressed when the note it targets is already in the feed as one
    // of these.
    const CONTENT_KINDS = new Set([1, 20, 21, 22, 1063, 1068, 1111, 30023, 34235, 34236, 9802]);
    const originalNoteIds = new Set<string>();
    for (const e of filtered) {
      if (CONTENT_KINDS.has(e.kind)) originalNoteIds.add(e.id);
    }
    const seen = new Set<string>();
    const seenRepostedIds = new Set<string>();
    filtered = filtered.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      if (e.kind === 6 || e.kind === 16) {
        let origId: string | undefined;
        try { if (e.content?.startsWith('{')) origId = JSON.parse(e.content).id; } catch { /* ignore */ }
        if (!origId) origId = e.tags.find(t => t[0] === 'e')?.[1];
        if (origId) {
          if (seen.has(origId) || seenRepostedIds.has(origId)) return false;
          seenRepostedIds.add(origId);
        }
      }
      if ((e.kind === 7 || e.kind === 9735) && e.tags.find(t => t[0] === 'e')?.[1]) {
        const targetId = e.tags.find(t => t[0] === 'e')![1];
        if (originalNoteIds.has(targetId)) return false;
      }
      if (e.kind === 1 && seenRepostedIds.has(e.id)) return false;
      return true;
    });

    return { events: filtered, eventLookup: lookup };
  }, [rawEvents, mutedPubkeys]);

  // ── Kind filtering ──────────────────────────────────────────────────────────
  // Hoisted out of the component so the useMemo dep array stays stable.
  // (Was previously recreated on every render, which is why the exhaustive-deps
  // rule flagged it.)

  const filteredEvents = useMemo(() => {
    if (!events) return events;
    let result = events;

    // Kind filters — evaluated by the shared rule in @core so web and mobile
    // agree. Loose mode keeps a note when something SPECIFIC about it is still
    // wanted; the generic shortNotes/replies/other buckets don't count, since
    // letting them count made "hide images" a no-op (every image post is also
    // a short note).
    if (kindFilters.size > 0) {
      result = result.filter(note =>
        noteMatchesKindFilters(getNoteCategories(note, eventLookup), kindFilters, CATEGORY_TO_FILTER, filterMode)
      );
    }

    // Content filters — same shared predicate the web feed uses.
    //
    // The resolver lets the text filter read a repost's *reposted note*. Usually
    // that note is embedded in the repost's content, but a bare envelope (just
    // an `e` tag) is legal NIP-18 and common, and there the phrase is on screen
    // with nothing in the repost itself to match. `eventLookup` covers targets
    // in the feed, the fetch cache covers ones already pulled in elsewhere; a
    // target neither has yet is left alone until it resolves.
    if (hasContentFilters) {
      const textLower = debouncedHideExactText.trim().toLowerCase();
      const resolveEvent = (id: string) => eventLookup?.get(id) ?? getCachedEvent(id);
      result = result.filter(note =>
        noteMatchesContentFilters(note, feedContentFilterConfig, textLower, resolveEvent)
      );
    }

    // Hashtag filters — only show notes whose hashtags match the selection.
    // Reactions/zaps check their target note's hashtags; if the target is unknown, hide them.
    // Reposts check embedded content. Regular notes check tags + inline #hashtags.
    // (Same rules as web — mobile previously ignored the reaction/zap target and
    // so kept reactions that matched nothing the user had selected.)
    if (hashtagFilters.size > 0) {
      result = result.filter(note => {
        if (note.kind === 7 || note.kind === 9735) {
          const targetId = note.tags.find(t => t[0] === 'e')?.[1];
          const target = targetId ? eventLookup?.get(targetId) : null;
          if (target) return noteMatchesHashtags(target, hashtagFilters);
          return false; // Unknown target — hide to keep results deterministic
        }
        return noteMatchesHashtags(note, hashtagFilters);
      });
    }

    // Filter dismissed notes
    result = result.filter(note => {
      if (isDismissed(note.id)) return false;
      // Saved-for-later notes leave the feed the same way dismissed ones do —
      // they live on the Saved corkboard now. Notes saved THIS session keep
      // their placeholder for the consolidate flow (parity with web).
      if (isCollapsed(note.id) && !isCollapsedThisSession(note.id)) return false;
      // Belongs to a dismissed thread root (persisted via "dismiss all
      // associated") — hide it even if it arrived after the dismissal, or if
      // the root itself is no longer in view.
      if (dismissedThreadRootSet.has(note.id)) return false;
      // Auto-dismiss: if this note references a dismissed note OR a dismissed
      // thread root via an e-tag, hide it too.
      for (const tag of note.tags) {
        if (tag[0] === 'e' && tag[1] && (isDismissed(tag[1]) || dismissedThreadRootSet.has(tag[1]))) return false;
      }
      return true;
    });

    return result;
  }, [events, kindFilters, filterMode, hashtagFilters, feedContentFilterConfig, debouncedHideExactText, hasContentFilters, eventLookup, isDismissed, isCollapsed, isCollapsedThisSession, dismissedThreadRootSet]);

  // Count dismissed notes from the deduped set (before kind/hashtag filters)
  const dismissedCount = useMemo(
    () => (events ?? []).filter(e => isDismissed(e.id)).length,
    [events, isDismissed],
  );

  // ── Stats for filter UI ─────────────────────────────────────────────────────
  const noteKindStats = useMemo(() => computeNoteKindStats(events, eventLookup), [events, eventLookup]);
  const hashtagData = useMemo(() => {
    if (!events || events.length === 0) return [];
    const counts = computeHashtagCounts(events);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([tag, count]) => ({ tag, count }));
  }, [events]);

  const hasActiveFilters = kindFilters.size > 0 || hashtagFilters.size > 0 || hasContentFilters;

  // ── Prefetch NIP-65 relays for contacts ─────────────────────────────────────
  useEffect(() => {
    if (contacts && contacts.length > 0) {
      fetchRelaysForMultiple(contacts.slice(0, 200));
    }
  }, [contacts, fetchRelaysForMultiple]);

  // ── Batch-prefetch author profiles ──────────────────────────────────────────
  useEffect(() => {
    if (filteredEvents && filteredEvents.length > 0) {
      prefetchFromNotes(filteredEvents);
    }
  }, [filteredEvents, prefetchFromNotes]);

  // ── Fresh-note highlighting ─────────────────────────────────────────────────
  /* eslint-disable react-hooks/set-state-in-effect -- fresh set is derived from
     data-arrival over time (diffed against a ref baseline), which needs an effect. */
  // Reset the baseline when switching tabs so a board doesn't open all-fresh.
  useEffect(() => {
    newestSeenRef.current = null;
    setFreshIds(prev => (prev.size ? new Set() : prev));
  }, [activeTab]);
  // Mark notes newer than the last-settled baseline as fresh.
  useEffect(() => {
    const evs = filteredEvents;
    if (!evs || evs.length === 0) return;
    let currentMax = 0;
    for (const e of evs) if (e.created_at > currentMax) currentMax = e.created_at;
    if (newestSeenRef.current === null) { newestSeenRef.current = currentMax; return; } // first paint: baseline only
    if (currentMax > newestSeenRef.current) {
      const cutoff = newestSeenRef.current;
      newestSeenRef.current = currentMax;
      setFreshIds(new Set(evs.filter(e => e.created_at > cutoff).map(e => e.id)));
    }
  }, [filteredEvents]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-scroll to top when the fresh set grows (opt-in). Mirrors web's
  // freshNoteIds-growth scroll trigger.
  useEffect(() => {
    const grew = freshIds.size > prevFreshSizeRef.current;
    prevFreshSizeRef.current = freshIds.size;
    if (grew && autoScrollTop) {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [freshIds, autoScrollTop]);

  // Detect deleted/vanished authors (NIP-09 profile deletion / NIP-62 vanish)
  // across the feed's visible authors in one batched query, provided via context.
  const visibleAuthors = useMemo(
    () => [...new Set((filteredEvents ?? []).map(n => n.pubkey).filter(Boolean))],
    [filteredEvents],
  );
  const deletedAuthors = useDeletedAuthors(visibleAuthors);

  // ── Feed label ──────────────────────────────────────────────────────────────
  const feedLabel = useMemo(() => {
    const count = filteredEvents?.length ?? 0;
    const totalLoaded = events?.length ?? 0;
    const statsStr = count > 0
      ? `${count} showing${totalLoaded > count ? ` (${totalLoaded} loaded)` : ''}${dismissedCount > 0 ? ` · ${dismissedCount} dismissed` : ''}`
      : '';
    if (isCustomTab && activeCustomFeed) return statsStr ? `${activeCustomFeed.title} · ${statsStr}` : activeCustomFeed.title;
    if (isGlobalTab) return statsStr ? `Global · ${statsStr}` : 'Global feed';
    if (pubkey && contacts && contacts.length > 0) return statsStr ? `Following ${contacts.length} · ${statsStr}` : `Following ${contacts.length}`;
    return 'Global feed';
  }, [isCustomTab, isGlobalTab, activeCustomFeed, pubkey, contacts, filteredEvents, events, dismissedCount]);

  // ── Callbacks ───────────────────────────────────────────────────────────────
  // Comment button → open the full thread with the reply composer targeting
  // this note (parity with web), instead of jumping straight to compose.
  const handleReply = useCallback((event: NostrEvent) => {
    setThreadAutoReply(event);
    setViewingThread(event.id);
  }, []);

  const handleFilterByKind = useCallback((kind: KindFilter | 'all' | 'none') => {
    setKindFilters(prev => {
      if (kind === 'all') return new Set();
      if (kind === 'none') {
        const all: KindFilter[] = ['posts', 'replies', 'articles', 'videos', 'images', 'reposts', 'reactions', 'highlights', 'recipes'];
        return new Set(all);
      }
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }, []);

  const handleFilterByHashtag = useCallback((tag: string) => {
    setHashtagFilters(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);

  const handleClearFilters = useCallback(() => {
    setKindFilters(new Set());
    setHashtagFilters(new Set());
    setContentFilterConfig(DEFAULT_CONTENT_FILTERS);
  }, []);

  const handleTabSwitch = useCallback((tab: FeedTab) => {
    // Discard relay work queued for the tab we're leaving. Nothing used to
    // cancel it, so fast successive switches stacked complete fan-outs — feed
    // query, profile prefetch, parent lookups, engagement — while only the last
    // tab's results were ever shown. Queued work is dropped before it starts;
    // already-open sockets finish (abandoning a handshake mid-flight wastes the
    // work without giving the CPU back). (Mirrors web.)
    bumpQueryEpoch();
    setActiveTab(tab);
    // Reset filters on tab switch
    setKindFilters(new Set());
    setHashtagFilters(new Set());
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [setActiveTab]);

  // Check if media filter is active (images or videos only selected)
  const mediaFilterActive = useMemo(() => {
    if (kindFilters.size === 0) return false;
    const allKinds: KindFilter[] = ['posts', 'replies', 'articles', 'videos', 'images', 'reposts', 'reactions', 'highlights', 'recipes'];
    const enabledKinds = allKinds.filter(k => !kindFilters.has(k));
    return enabledKinds.length > 0 && enabledKinds.every(k => k === 'images' || k === 'videos');
  }, [kindFilters]);

  // Active corkboard hashtags — used to flag notes tagged with the hashtag but
  // not mentioning it in their text (see hashtagFeedVerdict).
  const activeHashtags = useMemo(
    () => (isCustomTab ? (activeCustomFeed?.hashtags ?? []) : []),
    [isCustomTab, activeCustomFeed?.hashtags],
  );

  // ── renderNote ──────────────────────────────────────────────────────────────
  const renderNote = useCallback(
    ({ item }: { item: NostrEvent }) => {
      const hashtagTaggedOnly = activeHashtags.length > 0
        && !activeHashtags.some(tag => hashtagFeedVerdict(item, tag) === 'match')
        && activeHashtags.some(tag => hashtagFeedVerdict(item, tag) === 'tagged-only');
      const hashtagTaggedLabel = hashtagTaggedOnly
        ? activeHashtags.find(tag => hashtagFeedVerdict(item, tag) === 'tagged-only')
        : undefined;
      return (
        <NoteCard
          event={item}
          onReply={handleReply}
          isBookmarked={isBookmarked(item.id)}
          onToggleBookmark={toggleBookmark}
          onViewProfile={setViewingProfile}
          onViewThread={setViewingThread}
          mediaFilterActive={mediaFilterActive}
          hashtagTaggedOnly={hashtagTaggedOnly}
          hashtagTaggedLabel={hashtagTaggedLabel}
          isFresh={freshIds.has(item.id)}
          pinnedSet={pinnedSet}
          onTogglePin={togglePin}
          showCollapseActions
        />
      );
    },
    [handleReply, isBookmarked, toggleBookmark, mediaFilterActive, activeHashtags, freshIds, pinnedSet, togglePin],
  );

  // ── Loading state ───────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#b3b3b3" size="large" />
        <Text style={styles.loadingText}>Connecting to relays...</Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Could not load feed</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Build tabs list ─────────────────────────────────────────────────────────
  const tabs: { key: FeedTab; label: string }[] = [
    { key: 'following', label: 'Following' },
    ...customFeeds.map(f => ({
      key: `feed:${f.id}` as FeedTab,
      label: f.title || f.id.slice(0, 8),
    })),
    { key: 'global', label: 'Global' },
  ];

  return (
    <HashtagActionContext.Provider value={hashtagActionValue}>
    <DeletedAuthorsContext.Provider value={deletedAuthors}>
    <ProfileModalProvider onViewThread={(id) => setViewingThread(id)}>
      <DeepLinkHandler onThread={setViewingThread} />
      <View style={styles.container}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              {/* eslint-disable-next-line @typescript-eslint/no-require-imports -- RN static asset */}
              <Image source={require('../../assets/corky-wordmark.png')} style={styles.headerLogo} resizeMode="contain" />
              <Text style={styles.subtitle}>{feedLabel}</Text>
            </View>
            <TouchableOpacity
              style={styles.composeBtn}
              onPress={() => { setReplyTarget(null); setComposing(true); }}
            >
              <Text style={styles.composeBtnText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Tab bar ────────────────────────────────────────────────── */}
        <View style={styles.tabBarContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabBarScroll}
          >
            {tabs.map(tab => {
              const isActive = tab.key === activeTab;
              const customFeed = tab.key.startsWith('feed:')
                ? customFeeds.find(f => `feed:${f.id}` === tab.key)
                : undefined;
              return (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.tab, isActive && styles.tabActive]}
                  onPress={() => handleTabSwitch(tab.key)}
                  onLongPress={customFeed ? () => openEditBoard(customFeed) : undefined}
                  delayLongPress={350}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.tabText, isActive && styles.tabTextActive]} numberOfLines={1}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.tab, styles.tabAdd]}
              onPress={openNewBoard}
              activeOpacity={0.7}
              accessibilityLabel="New corkboard"
            >
              <Text style={styles.tabAddText}>＋ Board</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        {/* ── Filters ────────────────────────────────────────────────── */}
        {(filteredEvents && filteredEvents.length > 0) && (
          <View style={styles.filtersWrapper}>
            <FeedFilters
              collapsed={filtersCollapsed}
              onToggleCollapsed={() => setFiltersCollapsed(c => !c)}
              kindFilters={kindFilters}
              onFilterByKind={handleFilterByKind}
              filterMode={filterMode}
              onToggleFilterMode={() => setFilterMode(m => m === 'any' ? 'strict' : 'any')}
              stats={noteKindStats}
              hashtagFilters={hashtagFilters}
              onFilterByHashtag={handleFilterByHashtag}
              hashtags={hashtagData}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={handleClearFilters}
            >
              <ContentFilters
                config={contentFilterConfig}
                onChange={handleContentFilterChange}
                hasActiveFilters={hasContentFilters}
              />
            </FeedFilters>
          </View>
        )}

        {/* ── Feed ───────────────────────────────────────────────────── */}
        <FlatList
          ref={flatListRef}
          data={filteredEvents ?? []}
          keyExtractor={item => item.id}
          renderItem={renderNote}
          contentContainerStyle={styles.list}
          onScroll={e => setScrolledFromTop(e.nativeEvent.contentOffset.y > 0)}
          scrollEventThrottle={16}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          initialNumToRender={10}
          windowSize={10}
          updateCellsBatchingPeriod={50}
          ItemSeparatorComponent={NoteSeparator}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={refetch}
              tintColor="#b3b3b3"
            />
          }
          ListEmptyComponent={<Text style={styles.emptyText}>No notes found</Text>}
          onEndReached={() => {
            if ((isFollowingTab || isGlobalTab) && !isLoadingMore) {
              loadMoreByCount(FEED_PAGE_SIZE_MOBILE);
            } else if (isCustomTab && !customLoadingMore) {
              // Custom corkboards paginate through their own cache-backed loader,
              // which iterates to accumulate a full page of new notes (no gaps).
              setCustomLoadingMore(true);
              customLoadMore(0).finally(() => setCustomLoadingMore(false));
            }
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={(isLoadingMore || customLoadingMore) ? (
            <View style={{ paddingVertical: 16, alignItems: 'center' }}>
              <Text style={{ color: '#888', fontSize: 12 }}>Loading more…</Text>
            </View>
          ) : null}
        />

        {/* ── Scroll to top ──────────────────────────────────────────── */}
        {scrolledFromTop && (
          <TouchableOpacity
            style={styles.scrollTopBtn}
            activeOpacity={0.7}
            onPress={() => flatListRef.current?.scrollToOffset({ offset: 0, animated: true })}
            accessibilityLabel="Scroll to top"
          >
            <View style={styles.scrollTopTriangle} />
          </TouchableOpacity>
        )}

        {/* ── Compose modal ──────────────────────────────────────────── */}
        <Modal visible={composing} animationType="slide">
          <ComposeScreen
            onClose={() => { setComposing(false); setReplyTarget(null); refetch(); }}
            replyTo={replyTarget ? { id: replyTarget.id, pubkey: replyTarget.pubkey, tags: replyTarget.tags } : undefined}
          />
        </Modal>

        {/* ── Profile modal ──────────────────────────────────────────── */}
        <Modal visible={!!viewingProfile} animationType="slide">
          {viewingProfile && (
            <ProfileScreen
              pubkey={viewingProfile}
              onBack={() => setViewingProfile(null)}
              onViewThread={(id) => { setViewingProfile(null); setViewingThread(id); }}
            />
          )}
        </Modal>

        {/* ── Thread modal ───────────────────────────────────────────── */}
        <Modal visible={!!viewingThread} animationType="slide">
          {viewingThread && (
            <ThreadScreen
              eventId={viewingThread}
              autoReplyTo={threadAutoReply}
              onBack={() => { setViewingThread(null); setThreadAutoReply(null); }}
              onNavigateThread={(id: string) => { setThreadAutoReply(null); setViewingThread(id); }}
            />
          )}
        </Modal>

        {/* ── Corkboard builder ──────────────────────────────────────── */}
        <CorkboardBuilderModal
          visible={builderVisible}
          resetKey={builderKey}
          onClose={() => setBuilderVisible(false)}
          onSave={handleSaveBoard}
          onDelete={handleDeleteBoard}
          editingFeed={editingFeed
            ? { ...editingFeed, hashtags: editingFeed.hashtags ?? [] }
            : null}
        />
      </View>
    </ProfileModalProvider>
    </DeletedAuthorsContext.Provider>
    </HashtagActionContext.Provider>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 16 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 8, borderBottomWidth: 0, borderBottomColor: '#404040' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  headerLogo: { height: 24, width: 96, alignSelf: 'flex-start' },
  subtitle: { fontSize: 12, color: '#b3b3b3', marginTop: 2 },
  composeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#f97316', alignItems: 'center', justifyContent: 'center',
  },
  composeBtnText: { color: '#fff', fontSize: 22, fontWeight: '300', marginTop: -1 },

  // Tab bar
  tabBarContainer: {
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
    backgroundColor: '#262626',
  },
  tabBarScroll: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#333',
  },
  tabActive: {
    backgroundColor: '#a855f7',
  },
  tabText: {
    fontSize: 13,
    color: '#b3b3b3',
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  tabAdd: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#555',
    borderStyle: 'dashed',
  },
  tabAddText: {
    fontSize: 13,
    color: '#a855f7',
    fontWeight: '600',
  },

  // Filters
  filtersWrapper: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 2,
  },

  // Feed list
  list: { padding: 12, paddingBottom: 80 },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  errorText: { color: '#b3b3b3', fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#333', borderRadius: 8 },
  retryText: { color: '#f97316', fontSize: 14 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60 },

  // Scroll to top
  scrollTopBtn: {
    position: 'absolute', bottom: 80, left: 0, right: 0,
    alignItems: 'center', zIndex: 40, padding: 8,
  },
  scrollTopTriangle: {
    width: 0, height: 0,
    borderLeftWidth: 20, borderLeftColor: 'transparent',
    borderTopWidth: 20, borderTopColor: 'rgba(22, 163, 74, 0.8)',
    transform: [{ rotate: '-45deg' }],
  },
});
