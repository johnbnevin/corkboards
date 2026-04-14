import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Modal,
  ScrollView,
} from 'react-native';
import type { FlatList as FlatListType } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useFeed, useContacts } from '../hooks/useFeed';
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
import { ZapDialog } from '../components/ZapDialog';
import { ProfileModalProvider } from '../components/ProfileModal';
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

  if (hasVideoContent(event) || repostedKind === 34235 || repostedKind === 34236 || (targetEvent && hasVideoContent(targetEvent))) cats.add('videos');
  if (hasImageContent(event) || (targetEvent && hasImageContent(targetEvent))) cats.add('images');
  if (event.kind === 30023 && event.tags.some(t => (t[0] === 'r' && t[1]?.includes('zap.cooking')) || (t[0] === 't' && t[1] === 'recipe'))) cats.add('recipes');
  if (event.kind === 6 || event.kind === 16) cats.add('reposts');
  if (event.kind === 7 || event.kind === 9735) cats.add('reactions');
  if (event.kind === 9802) cats.add('highlights');
  if (event.kind === 30023 && !cats.has('recipes')) cats.add('longForm');
  if (event.kind === 1) {
    cats.add(event.tags.some(t => t[0] === 'e') ? 'replies' : 'shortNotes');
  }
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
  const { isDismissed } = useCollapsedNotes();
  const { limit } = useFeedLimit();

  // ── UI state ────────────────────────────────────────────────────────────────
  const [composing, setComposing] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<string | null>(null);
  const [viewingThread, setViewingThread] = useState<string | null>(null);
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);
  const flatListRef = useRef<FlatListType<NostrEvent>>(null);

  // ── Tab / feed switching ────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useLocalStorage<FeedTab>('home:active-tab', 'following');
  const [customFeeds] = useLocalStorage<CustomFeed[]>('nostr-custom-feeds', []);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
  const [kindFilters, setKindFilters] = useState<Set<KindFilter>>(new Set());
  const [filterMode, setFilterMode] = useState<'any' | 'strict'>('any');
  const [hashtagFilters, setHashtagFilters] = useState<Set<string>>(new Set());

  // ── Following feed ──────────────────────────────────────────────────────────
  const authors = pubkey && contacts && contacts.length > 0 ? contacts : [];
  const isFollowingTab = activeTab === 'following';
  const isGlobalTab = activeTab === 'global';
  const { data: rawFollowEvents, isLoading: followLoading, isError: followError, refetch: followRefetch, isFetching: followFetching } =
    useFeed(isFollowingTab || isGlobalTab ? authors : []);

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
    };
  }, [activeCustomFeed]);

  const {
    notes: customNotes,
    isLoading: customLoading,
    refresh: customRefresh,
  } = useCustomFeedNotes({
    feed: customFeedDef,
    isActive: !!activeFeedId,
    limit,
    multiplier: 1,
  });

  // ── Pick the right data for the active tab ──────────────────────────────────
  const isCustomTab = !!activeFeedId;
  const rawEvents = isCustomTab ? customNotes : rawFollowEvents;
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

    const originalNoteIds = new Set<string>();
    for (const e of filtered) {
      if (e.kind === 1 || e.kind === 30023) originalNoteIds.add(e.id);
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
  const categoryToFilter: Record<string, KindFilter> = {
    shortNotes: 'posts', replies: 'replies', longForm: 'articles',
    videos: 'videos', images: 'images', reposts: 'reposts', reactions: 'reactions',
    highlights: 'highlights', recipes: 'recipes', other: 'posts',
  };

  const filteredEvents = useMemo(() => {
    if (!events) return events;
    let result = events;

    // Kind filters
    if (kindFilters.size > 0) {
      result = result.filter(note => {
        const cats = getNoteCategories(note, eventLookup);
        if (filterMode === 'strict') {
          for (const cat of cats) {
            const f = categoryToFilter[cat];
            if (f && kindFilters.has(f)) return false;
          }
          return true;
        } else {
          for (const cat of cats) {
            const f = categoryToFilter[cat];
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
    result = result.filter(note => !isDismissed(note.id));

    return result;
  }, [events, kindFilters, filterMode, hashtagFilters, eventLookup, isDismissed]);

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
  const handleReply = useCallback((event: NostrEvent) => {
    setReplyTarget(event);
    setComposing(true);
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

  // ── renderNote ──────────────────────────────────────────────────────────────
  const renderNote = useCallback(
    ({ item }: { item: NostrEvent }) => (
      <NoteCard
        event={item}
        onReply={handleReply}
        isBookmarked={isBookmarked(item.id)}
        onToggleBookmark={() => toggleBookmark(item.id)}
        onViewProfile={setViewingProfile}
        onViewThread={setViewingThread}
        mediaFilterActive={mediaFilterActive}
      />
    ),
    [handleReply, isBookmarked, toggleBookmark, mediaFilterActive],
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
    <ProfileModalProvider onViewThread={(id) => setViewingThread(id)}>
      <View style={styles.container}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Corkboards</Text>
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
              onBack={() => setViewingThread(null)}
              onNavigateThread={(id: string) => setViewingThread(id)}
            />
          )}
        </Modal>

        {/* ── Zap dialog ─────────────────────────────────────────────── */}
        <ZapDialog
          note={zapTarget}
          visible={!!zapTarget}
          onClose={() => setZapTarget(null)}
        />
      </View>
    </ProfileModalProvider>
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
