/**
 * Discover screen — algorithmic discovery feed showing notes from outside
 * the user's follow list, ranked by engagement from people they follow.
 *
 * Enhanced with:
 * - Trending hashtag section at the top
 * - Content type filters (note kind toggles)
 * - Search functionality (user/hashtag search)
 * - ZapDialog and ProfileModal wiring
 *
 * Mirrors web's discover tab in MultiColumnClient.
 */
import { useCallback, useRef, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Modal,
} from 'react-native';
import type { FlatList as FlatListType } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuth } from '../lib/AuthContext';
import { useDiscover } from '../hooks/useDiscover';
import { useContacts } from '../hooks/useFeed';
import { useMuteList } from '../hooks/useMuteList';
import { useBookmarks } from '../hooks/useBookmarks';
import { useBulkAuthors } from '../hooks/useAuthor';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useNostrBackup } from '../hooks/useNostrBackup';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { NoteCard } from '../components/NoteCard';
import { OnboardSearchWidget } from '../components/OnboardSearchWidget';
import { ZapDialog } from '../components/ZapDialog';
import { ProfileScreen } from './ProfileScreen';

// ---- Kind filter types ----

type KindFilter = 'text' | 'long' | 'video' | 'repost';

const KIND_DEFS: { kind: KindFilter; label: string; nostrKind: number }[] = [
  { kind: 'text',   label: 'Notes',     nostrKind: 1 },
  { kind: 'long',   label: 'Articles',  nostrKind: 30023 },
  { kind: 'video',  label: 'Video',     nostrKind: 34235 },
  { kind: 'repost', label: 'Reposts',   nostrKind: 6 },
];

// ---- Trending hashtags extraction ----

function extractHashtags(notes: NostrEvent[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const tTags = note.tags.filter(t => t[0] === 't' && t[1]);
    for (const t of tTags) {
      const normalized = t[1].toLowerCase();
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
    // Also extract from content
    const matches = note.content.match(/#(\w{2,})/g);
    if (matches) {
      for (const m of matches) {
        const normalized = m.slice(1).toLowerCase();
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ---- Hashtag badges ----

function HashtagBadges({
  hashtags,
  activeFilters,
  onToggle,
}: {
  hashtags: { tag: string; count: number }[];
  activeFilters: Set<string>;
  onToggle: (tag: string) => void;
}) {
  if (hashtags.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={hashtagStyles.container}
    >
      {hashtags.map(({ tag, count }) => {
        const active = activeFilters.has(tag);
        return (
          <TouchableOpacity
            key={tag}
            style={[hashtagStyles.badge, active && hashtagStyles.badgeActive]}
            onPress={() => onToggle(tag)}
          >
            <Text style={[hashtagStyles.badgeText, active && hashtagStyles.badgeTextActive]}>
              #{tag}
            </Text>
            <Text style={[hashtagStyles.badgeCount, active && hashtagStyles.badgeCountActive]}>
              {count}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const hashtagStyles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingVertical: 6, gap: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#404040',
    backgroundColor: '#2a2a2a',
  },
  badgeActive: {
    backgroundColor: '#f97316',
    borderColor: '#f97316',
  },
  badgeText: { color: '#b3b3b3', fontSize: 12 },
  badgeTextActive: { color: '#000' },
  badgeCount: { color: '#666', fontSize: 11 },
  badgeCountActive: { color: 'rgba(0,0,0,0.6)' },
});

// ---- Kind toggle bar ----

function KindToggles({
  activeKinds,
  onToggle,
  stats,
}: {
  activeKinds: Set<KindFilter>;
  onToggle: (kind: KindFilter) => void;
  stats: Record<KindFilter, number>;
}) {
  return (
    <View style={kindStyles.bar}>
      {KIND_DEFS.map(({ kind, label }) => {
        const active = activeKinds.has(kind);
        const count = stats[kind] || 0;
        return (
          <TouchableOpacity
            key={kind}
            style={[kindStyles.chip, active && kindStyles.chipActive]}
            onPress={() => onToggle(kind)}
          >
            <Text style={[kindStyles.chipText, active && kindStyles.chipTextActive]}>
              {label}
            </Text>
            {count > 0 && (
              <Text style={[kindStyles.chipCount, active && kindStyles.chipCountActive]}>
                {count}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const kindStyles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingVertical: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#404040',
    backgroundColor: '#2a2a2a',
  },
  chipActive: { backgroundColor: '#a855f7', borderColor: '#a855f7' },
  chipText: { color: '#b3b3b3', fontSize: 12 },
  chipTextActive: { color: '#fff' },
  chipCount: { color: '#666', fontSize: 11 },
  chipCountActive: { color: 'rgba(255,255,255,0.7)' },
});

// ---- Main component ----

export function DiscoverScreen() {
  const { pubkey, signer } = useAuth();
  const { data: contacts } = useContacts(pubkey ?? undefined);
  const { mutedPubkeys } = useMuteList();
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const { saveBackup } = useNostrBackup(pubkey, signer);
  useBulkAuthors();
  const flatListRef = useRef<FlatListType<NostrEvent>>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeKinds, setActiveKinds] = useState<Set<KindFilter>>(new Set());
  const [hashtagFilters, setHashtagFilters] = useState<Set<string>>(new Set());
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);
  const [viewingProfile, setViewingProfile] = useState<string | null>(null);

  // Onboarding state — show search widget when user has fewer than target follows
  const [onboardingSkipped, setOnboardingSkipped] = useLocalStorage<boolean>(STORAGE_KEYS.ONBOARDING_SKIPPED, false);
  const [onboardFollowTarget] = useLocalStorage<number>(STORAGE_KEYS.ONBOARDING_FOLLOW_TARGET, 10);
  const isOnboarding = contacts !== undefined && (contacts.length ?? 0) < onboardFollowTarget && !onboardingSkipped;

  const follows = pubkey && contacts && contacts.length > 0 ? contacts : undefined;
  const { discoveredNotes, isLoading, refresh, loadMore, hasMoreDiscover, totalDiscoverCount } = useDiscover(follows);

  // Mute filter
  const muteFiltered = useMemo(() => {
    if (!discoveredNotes || mutedPubkeys.size === 0) return discoveredNotes;
    return discoveredNotes.filter(e => !mutedPubkeys.has(e.pubkey));
  }, [discoveredNotes, mutedPubkeys]);

  // Extract trending hashtags from all discovered notes
  const trendingHashtags = useMemo(
    () => extractHashtags(muteFiltered ?? []),
    [muteFiltered],
  );

  // Kind stats
  const kindStats = useMemo((): Record<KindFilter, number> => {
    const s: Record<KindFilter, number> = { text: 0, long: 0, video: 0, repost: 0 };
    for (const note of muteFiltered ?? []) {
      if (note.kind === 1) s.text++;
      else if (note.kind === 30023) s.long++;
      else if (note.kind === 34235) s.video++;
      else if (note.kind === 6) s.repost++;
    }
    return s;
  }, [muteFiltered]);

  // Apply kind filters
  const kindFiltered = useMemo(() => {
    if (activeKinds.size === 0) return muteFiltered;
    const kindSet = new Set<number>();
    for (const k of activeKinds) {
      const def = KIND_DEFS.find(d => d.kind === k);
      if (def) kindSet.add(def.nostrKind);
    }
    return (muteFiltered ?? []).filter(e => kindSet.has(e.kind));
  }, [muteFiltered, activeKinds]);

  // Apply hashtag filters
  const hashtagFiltered = useMemo(() => {
    if (hashtagFilters.size === 0) return kindFiltered;
    return (kindFiltered ?? []).filter(note => {
      const noteTags = new Set<string>();
      for (const t of note.tags) {
        if (t[0] === 't' && t[1]) noteTags.add(t[1].toLowerCase());
      }
      const contentMatches = note.content.match(/#(\w{2,})/g);
      if (contentMatches) {
        for (const m of contentMatches) noteTags.add(m.slice(1).toLowerCase());
      }
      for (const f of hashtagFilters) {
        if (noteTags.has(f)) return true;
      }
      return false;
    });
  }, [kindFiltered, hashtagFilters]);

  // Apply search filter
  const notes = useMemo(() => {
    if (!searchQuery.trim()) return hashtagFiltered;
    const q = searchQuery.toLowerCase().trim();
    // Search in content and hashtags
    return (hashtagFiltered ?? []).filter(note => {
      if (note.content.toLowerCase().includes(q)) return true;
      // Match hashtags
      if (q.startsWith('#')) {
        const tagQ = q.slice(1);
        return note.tags.some(t => t[0] === 't' && t[1]?.toLowerCase().includes(tagQ));
      }
      return false;
    });
  }, [hashtagFiltered, searchQuery]);

  const toggleKind = useCallback((kind: KindFilter) => {
    setActiveKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const toggleHashtag = useCallback((tag: string) => {
    const normalized = tag.toLowerCase();
    setHashtagFilters(prev => {
      const next = new Set(prev);
      if (next.has(normalized)) next.delete(normalized);
      else next.add(normalized);
      return next;
    });
  }, []);

  const hasActiveFilters = activeKinds.size > 0 || hashtagFilters.size > 0 || searchQuery.trim().length > 0;

  const clearFilters = useCallback(() => {
    setActiveKinds(new Set());
    setHashtagFilters(new Set());
    setSearchQuery('');
  }, []);

  // Batch-prefetch author profiles
  useBulkAuthors();

  const renderNote = useCallback(
    ({ item }: { item: NostrEvent }) => (
      <NoteCard
        event={item}
        isBookmarked={isBookmarked(item.id)}
        onToggleBookmark={() => toggleBookmark(item.id)}
      />
    ),
    [isBookmarked, toggleBookmark],
  );

  if (!pubkey) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Log in to discover new people and notes</Text>
      </View>
    );
  }

  if (!follows || follows.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: 60 }]}>
        <OnboardSearchWidget
          contactCount={contacts?.length ?? 0}
          followTarget={onboardFollowTarget}
          onSelectProfile={(pk) => setViewingProfile(pk)}
          onSkip={() => { setOnboardingSkipped(true); saveBackup().catch((e) => console.warn('[onboarding] backup failed:', e)); }}
        />
        <Text style={[styles.emptyText, { marginTop: 20 }]}>Follow some people to discover new content</Text>
        {viewingProfile && (
          <Modal visible animationType="slide">
            <ProfileScreen pubkey={viewingProfile} onBack={() => setViewingProfile(null)} />
          </Modal>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Discover</Text>
        <Text style={styles.subtitle}>
          {isLoading ? 'Finding new voices...' : `${totalDiscoverCount} notes from outside your network`}
        </Text>
      </View>

      {/* Onboarding widget — shown when user needs to follow more people */}
      {isOnboarding && (
        <OnboardSearchWidget
          contactCount={contacts?.length ?? 0}
          followTarget={onboardFollowTarget}
          onSelectProfile={(pk) => setViewingProfile(pk)}
          onSkip={() => { setOnboardingSkipped(true); saveBackup().catch((e) => console.warn('[onboarding] backup failed:', e)); }}
        />
      )}

      {/* Search bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes or #hashtags..."
          placeholderTextColor="#666"
          value={searchQuery}
          onChangeText={setSearchQuery}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity style={styles.searchClear} onPress={() => setSearchQuery('')}>
            <Text style={styles.searchClearText}>X</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Trending hashtags */}
      {trendingHashtags.length > 0 && !isLoading && (
        <View>
          <Text style={styles.sectionLabel}>Trending</Text>
          <HashtagBadges
            hashtags={trendingHashtags}
            activeFilters={hashtagFilters}
            onToggle={toggleHashtag}
          />
        </View>
      )}

      {/* Kind toggles */}
      {!isLoading && (muteFiltered ?? []).length > 0 && (
        <KindToggles activeKinds={activeKinds} onToggle={toggleKind} stats={kindStats} />
      )}

      {/* Active filters summary */}
      {hasActiveFilters && (
        <TouchableOpacity style={styles.clearFiltersBtn} onPress={clearFilters}>
          <Text style={styles.clearFiltersText}>Clear all filters</Text>
        </TouchableOpacity>
      )}

      {isLoading && (notes ?? []).length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" size="large" />
          <Text style={styles.loadingText}>Discovering notes...</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={notes}
          keyExtractor={item => item.id}
          renderItem={renderNote}
          contentContainerStyle={styles.list}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          initialNumToRender={10}
          windowSize={10}
          refreshControl={
            <RefreshControl
              refreshing={isLoading && (notes ?? []).length > 0}
              onRefresh={refresh}
              tintColor="#b3b3b3"
            />
          }
          onEndReached={hasMoreDiscover ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            hasActiveFilters ? (
              <View style={styles.emptyFiltered}>
                <Text style={styles.emptyText}>No notes match your filters</Text>
                <TouchableOpacity style={styles.showAllBtn} onPress={clearFilters}>
                  <Text style={styles.showAllText}>Clear filters</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.emptyText}>No discoveries yet</Text>
            )
          }
          ListFooterComponent={
            hasMoreDiscover ? (
              <TouchableOpacity style={styles.loadMoreBtn} onPress={loadMore}>
                <Text style={styles.loadMoreText}>Load more</Text>
              </TouchableOpacity>
            ) : null
          }
        />
      )}

      {/* Zap dialog */}
      <ZapDialog
        note={zapTarget}
        visible={!!zapTarget}
        onClose={() => setZapTarget(null)}
      />

      {/* Profile modal (from onboarding search) */}
      {viewingProfile && (
        <Modal visible animationType="slide">
          <ProfileScreen pubkey={viewingProfile} onBack={() => setViewingProfile(null)} />
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 16 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#404040' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  subtitle: { fontSize: 12, color: '#b3b3b3', marginTop: 2 },

  // Search
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f2f2f2',
    fontSize: 14,
  },
  searchClear: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchClearText: { color: '#666', fontSize: 14, fontWeight: '600' },

  // Section label
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 2,
  },

  // Clear filters
  clearFiltersBtn: {
    alignSelf: 'flex-start',
    marginLeft: 16,
    marginTop: 4,
    marginBottom: 2,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#333',
    borderRadius: 12,
  },
  clearFiltersText: { color: '#b3b3b3', fontSize: 11 },

  list: { padding: 12, gap: 8 },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60 },
  emptyFiltered: { alignItems: 'center', gap: 12 },
  showAllBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  showAllText: { color: '#f2f2f2', fontSize: 13 },
  loadMoreBtn: { alignItems: 'center', padding: 16 },
  loadMoreText: { color: '#f97316', fontSize: 14, fontWeight: '500' },
});
