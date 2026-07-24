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
import { hashtagFeedVerdict } from '@core/noteCategories';
import { useBulkAuthors } from '../hooks/useAuthor';
import { useNip65Relays } from '../hooks/useNip65Relays';
import { useMuteList } from '../hooks/useMuteList';
import { useBookmarks } from '../hooks/useBookmarks';
import { useCollapsedNotes } from '../hooks/useCollapsedNotes';
import { useAuth } from '../lib/AuthContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useCustomFeedNotes } from '../hooks/useCustomFeedNotes';
import { useFeedLimit } from '../hooks/useFeedLimit';
import { NoteCard } from '../components/NoteCard';
import { FeedFilters } from '../components/FeedFilters';
import type { KindFilter, NoteKindStats } from '../components/NoteKindToggles';
import { ProfileModalProvider } from '../components/ProfileModal';
import { DeepLinkHandler } from '../components/DeepLinkHandler';
import { ComposeScreen } from './ComposeScreen';
import { ProfileScreen } from './ProfileScreen';
import { ThreadScreen } from './ThreadScreen';

// ============================================================================
// Note classification helpers (ported from web MultiColumnClient)
// ============================================================================

const VIDEO_URL_PATTERNS = [
  /youtube\.com\/watch/i, /youtu\.be\//i, /youtube\.com\/shorts\//i,
  /youtube\.com\/embed\//i, /rumble\.com\/v[\w-]/i, /tiktok\.com\/.+\/video\//i,
  /vimeo\.com\/\d/i, /\.mp4\b/i, /\.webm\b/i, /\.mov\b/i,
];
const IMAGE_EXT_PATTERN = /\.(jpg|jpeg|png|webp|svg|bmp|gif)\b/i;
const IMAGE_CDN_PATTERNS = [
  /nostr\.build\/i\//i, /image\.nostr\.build\//i, /i\.nostr\.build\//i,
];

function hasVideoContent(note: NostrEvent): boolean {
  if (note.kind === 34235 || note.kind === 34236) return true;
  if (note.tags.some(t => t[0] === 'imeta' && t.some(v => /video/i.test(v)))) return true;
  return VIDEO_URL_PATTERNS.some(p => p.test(note.content || ''));
}

function hasImageContent(note: NostrEvent): boolean {
  const content = note.content || '';
  if (note.tags.some(t => t[0] === 'imeta' && t.some(v => /image/i.test(v)))) return true;
  if (IMAGE_EXT_PATTERN.test(content)) return true;
  if (IMAGE_CDN_PATTERNS.some(p => p.test(content))) return true;
  return false;
}

function getNoteCategories(event: NostrEvent, lookup?: Map<string, NostrEvent>): Set<string> {
  const cats = new Set<string>();
  const repostedKind = event.kind === 16 ? parseInt(event.tags.find(t => t[0] === 'k')?.[1] || '0', 10) : 0;

  const targetId = (event.kind === 7 || event.kind === 9735 || event.kind === 6 || event.kind === 16)
    ? event.tags.find(t => t[0] === 'e')?.[1] : null;
  let targetEvent = targetId && lookup ? lookup.get(targetId) : null;
  if (!targetEvent && (event.kind === 6 || event.kind === 16) && event.content?.startsWith('{')) {
    try { targetEvent = JSON.parse(event.content) as NostrEvent; } catch { /* not JSON */ }
  }

  if (event.kind === 21 || event.kind === 22 || hasVideoContent(event) || repostedKind === 34235 || repostedKind === 34236 || repostedKind === 21 || repostedKind === 22 || (targetEvent && hasVideoContent(targetEvent))) cats.add('videos');
  if (event.kind === 20 || hasImageContent(event) || (targetEvent && hasImageContent(targetEvent))) cats.add('images');
  if (event.kind === 30023 && event.tags.some(t => (t[0] === 'r' && t[1]?.includes('zap.cooking')) || (t[0] === 't' && t[1] === 'recipe'))) cats.add('recipes');
  if (event.kind === 6 || event.kind === 16) cats.add('reposts');
  if (event.kind === 7 || event.kind === 9735) cats.add('reactions');
  if (event.kind === 9802) cats.add('highlights');
  if (event.kind === 30023 && !cats.has('recipes')) cats.add('longForm');
  if (event.kind === 1) {
    cats.add(event.tags.some(t => t[0] === 'e') ? 'replies' : 'shortNotes');
  }
  // NIP-22 comment (kind 1111) is always a reply to something
  if (event.kind === 1111) cats.add('replies');
  // NIP-94 file metadata (kind 1063) — image or video by mime type
  if (event.kind === 1063) {
    const mime = event.tags.find(t => t[0] === 'm')?.[1] ?? '';
    if (mime.startsWith('video/')) cats.add('videos');
    else cats.add('images');
  }
  // NIP-88 poll (kind 1068) — grouped with short notes
  if (event.kind === 1068) cats.add('shortNotes');
  if (cats.size === 0) cats.add('other');
  return cats;
}

function getNoteHashtags(note: NostrEvent): Set<string> {
  const tags = new Set<string>();
  for (const t of note.tags) { if (t[0] === 't' && t[1]) tags.add(t[1].toLowerCase()); }
  for (const match of note.content.matchAll(/#([a-zA-Z]\w*)/g)) { tags.add(match[1].toLowerCase()); }
  return tags;
}

function getRepostHashtags(note: NostrEvent): Set<string> {
  if ((note.kind !== 6 && note.kind !== 16) || !note.content) return new Set();
  try {
    const embedded = JSON.parse(note.content);
    const tags = new Set<string>();
    if (Array.isArray(embedded.tags)) {
      for (const t of embedded.tags) {
        if (Array.isArray(t) && t[0] === 't' && typeof t[1] === 'string') tags.add(t[1].toLowerCase());
      }
    }
    if (typeof embedded.content === 'string') {
      for (const match of embedded.content.matchAll(/#([a-zA-Z]\w*)/g)) tags.add(match[1].toLowerCase());
    }
    return tags;
  } catch { return new Set(); }
}

function computeNoteKindStats(events: NostrEvent[] | undefined, lookup?: Map<string, NostrEvent>): NoteKindStats | undefined {
  if (!events || events.length === 0) return undefined;
  const stats: NoteKindStats = {
    total: events.length, shortNotes: 0, replies: 0, longForm: 0,
    reposts: 0, reactions: 0, videos: 0, images: 0, highlights: 0, recipes: 0, other: 0,
  };
  for (const event of events) {
    for (const cat of getNoteCategories(event, lookup)) {
      (stats as unknown as Record<string, number>)[cat]++;
    }
  }
  return stats;
}

function computeHashtagCounts(notes: NostrEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const tags = (note.kind === 6 || note.kind === 16) ? getRepostHashtags(note) : getNoteHashtags(note);
    for (const tag of tags) { counts.set(tag, (counts.get(tag) || 0) + 1); }
  }
  return counts;
}

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
  const { isDismissed, dismissedThreadRootSet } = useCollapsedNotes();
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
  const [activeTab, setActiveTab] = useLocalStorage<FeedTab>('home:active-tab', 'following');
  const [customFeeds, setCustomFeeds] = useLocalStorage<CustomFeed[]>('nostr-custom-feeds', []);

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

  // ── Mute + deduplicate ──────────────────────────────────────────────────────
  const events = useMemo(() => {
    if (!rawEvents) return rawEvents;
    let filtered = mutedPubkeys.size > 0
      ? rawEvents.filter(e => !mutedPubkeys.has(e.pubkey))
      : rawEvents;

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

    return filtered;
  }, [rawEvents, mutedPubkeys]);

  // ── Build event lookup for category classification ──────────────────────────
  const eventLookup = useMemo(() => {
    if (!events) return undefined;
    const map = new Map<string, NostrEvent>();
    for (const e of events) map.set(e.id, e);
    return map;
  }, [events]);

  // ── Kind filtering ──────────────────────────────────────────────────────────
  // Hoisted out of the component so the useMemo dep array stays stable.
  // (Was previously recreated on every render, which is why the exhaustive-deps
  // rule flagged it.)

  const filteredEvents = useMemo(() => {
    if (!events) return events;
    let result = events;

    // Kind filters
    if (kindFilters.size > 0) {
      result = result.filter(note => {
        const cats = getNoteCategories(note, eventLookup);
        if (filterMode === 'strict') {
          for (const cat of cats) {
            const f = CATEGORY_TO_FILTER[cat];
            if (f && kindFilters.has(f)) return false;
          }
          return true;
        } else {
          for (const cat of cats) {
            const f = CATEGORY_TO_FILTER[cat];
            if (!f || !kindFilters.has(f)) return true;
          }
          return false;
        }
      });
    }

    // Hashtag filters
    if (hashtagFilters.size > 0) {
      result = result.filter(note => {
        const tags = (note.kind === 6 || note.kind === 16) ? getRepostHashtags(note) : getNoteHashtags(note);
        for (const tag of tags) { if (hashtagFilters.has(tag)) return true; }
        return false;
      });
    }

    // Filter dismissed notes
    result = result.filter(note => {
      if (isDismissed(note.id)) return false;
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
  }, [events, kindFilters, filterMode, hashtagFilters, eventLookup, isDismissed, dismissedThreadRootSet]);

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

  const hasActiveFilters = kindFilters.size > 0 || hashtagFilters.size > 0;

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
  }, []);

  const handleTabSwitch = useCallback((tab: FeedTab) => {
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
          onToggleBookmark={() => toggleBookmark(item.id)}
          onViewProfile={setViewingProfile}
          onViewThread={setViewingThread}
          mediaFilterActive={mediaFilterActive}
          hashtagTaggedOnly={hashtagTaggedOnly}
          hashtagTaggedLabel={hashtagTaggedLabel}
        />
      );
    },
    [handleReply, isBookmarked, toggleBookmark, mediaFilterActive, activeHashtags],
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
              <Image source={require('../../assets/corky-logo.png')} style={styles.headerLogo} resizeMode="contain" />
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
              return (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.tab, isActive && styles.tabActive]}
                  onPress={() => handleTabSwitch(tab.key)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.tabText, isActive && styles.tabTextActive]} numberOfLines={1}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
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
            />
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
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
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
  headerLogo: { height: 28, width: 135, alignSelf: 'flex-start' },
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
