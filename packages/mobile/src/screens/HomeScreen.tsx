import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  Image,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Modal,
} from 'react-native';
import type { FlatList as FlatListType } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useFeed, useContacts } from '../hooks/useFeed';
import { useAuthor, useBulkAuthors } from '../hooks/useAuthor';
import { useNip65Relays } from '../hooks/useNip65Relays';
import { useMuteList } from '../hooks/useMuteList';
import { useBookmarks } from '../hooks/useBookmarks';
import { useAuth } from '../lib/AuthContext';
import { NoteContent } from '../components/NoteContent';
import { NoteActions } from '../components/NoteActions';
import { SizeGuardedImage } from '../components/SizeGuardedImage';
import { ComposeScreen } from './ComposeScreen';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';

// ============================================================================
// NoteCard
// ============================================================================

function NoteCard({ event, onReply, isBookmarked, onToggleBookmark }: { event: NostrEvent; onReply: (e: NostrEvent) => void; isBookmarked: boolean; onToggleBookmark: () => void }) {
  const { data } = useAuthor(event.pubkey);
  const isRepost = event.kind === 6;

  // For reposts, parse the inner event
  let displayEvent = event;
  if (isRepost) {
    try {
      const inner = JSON.parse(event.content);
      if (
        inner &&
        inner.id &&
        inner.pubkey &&
        typeof inner.kind === 'number' &&
        typeof inner.content === 'string'
      ) displayEvent = inner;
    } catch {}
  }

  const displayName =
    data?.metadata?.display_name || data?.metadata?.name || genUserName(event.pubkey);
  const avatar = data?.metadata?.picture;

  return (
    <View style={styles.card}>
      {isRepost && (
        <Text style={styles.repostBanner}>↻ {displayName} reposted</Text>
      )}
      <View style={styles.cardHeader}>
        {avatar ? (
          <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Text style={styles.avatarLetter}>{displayName[0]?.toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.headerText}>
          <RepostAuthorName event={displayEvent} fallbackName={displayName} isRepost={isRepost} />
          <Text style={styles.time}>{formatTimeAgo(displayEvent.created_at)}</Text>
        </View>
      </View>
      <NoteContent event={displayEvent} numberOfLines={12} />
      <NoteActions event={displayEvent} onReply={() => onReply(displayEvent)} isBookmarked={isBookmarked} onToggleBookmark={onToggleBookmark} />
    </View>
  );
}

/** Shows the actual author for reposts (not the reposter) */
function RepostAuthorName({ event, fallbackName, isRepost }: { event: NostrEvent; fallbackName: string; isRepost: boolean }) {
  const { data } = useAuthor(isRepost ? event.pubkey : undefined);
  if (!isRepost) return <Text style={styles.displayName} numberOfLines={1}>{fallbackName}</Text>;
  const name = data?.metadata?.display_name || data?.metadata?.name || genUserName(event.pubkey);
  return <Text style={styles.displayName} numberOfLines={1}>{name}</Text>;
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
  const [composing, setComposing] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  const flatListRef = useRef<FlatListType<NostrEvent>>(null);

  const authors = pubkey && contacts && contacts.length > 0 ? contacts : [];
  const { data: rawEvents, isLoading, isError, refetch, isFetching } = useFeed(authors);

  // Filter muted users from feed
  const events = useMemo(() => {
    if (!rawEvents || mutedPubkeys.size === 0) return rawEvents;
    return rawEvents.filter(e => !mutedPubkeys.has(e.pubkey));
  }, [rawEvents, mutedPubkeys]);

  // Prefetch NIP-65 relays for contacts
  useEffect(() => {
    if (contacts && contacts.length > 0) {
      fetchRelaysForMultiple(contacts.slice(0, 200));
    }
  }, [contacts, fetchRelaysForMultiple]);

  // Batch-prefetch author profiles
  useEffect(() => {
    if (events && events.length > 0) {
      prefetchFromNotes(events);
    }
  }, [events, prefetchFromNotes]);

  const feedLabel = pubkey && contacts && contacts.length > 0
    ? `Following ${contacts.length}`
    : 'Global feed';

  const handleReply = useCallback((event: NostrEvent) => {
    setReplyTarget(event);
    setComposing(true);
  }, []);

  const renderNote = useCallback(
    ({ item }: { item: NostrEvent }) => (
      <NoteCard
        event={item}
        onReply={handleReply}
        isBookmarked={isBookmarked(item.id)}
        onToggleBookmark={() => toggleBookmark(item.id)}
      />
    ),
    [handleReply, isBookmarked, toggleBookmark],
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#b3b3b3" size="large" />
        <Text style={styles.loadingText}>Connecting to relays…</Text>
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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
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

      <FlatList
        ref={flatListRef}
        data={events ?? []}
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
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !isLoading}
            onRefresh={refetch}
            tintColor="#b3b3b3"
          />
        }
        ListEmptyComponent={<Text style={styles.emptyText}>No notes found</Text>}
      />

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

      {/* Compose modal */}
      <Modal visible={composing} animationType="slide">
        <ComposeScreen
          onClose={() => { setComposing(false); setReplyTarget(null); refetch(); }}
          replyTo={replyTarget ? { id: replyTarget.id, pubkey: replyTarget.pubkey, tags: replyTarget.tags } : undefined}
        />
      </Modal>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 16 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  subtitle: { fontSize: 12, color: '#b3b3b3', marginTop: 2 },
  composeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#f97316', alignItems: 'center', justifyContent: 'center',
  },
  composeBtnText: { color: '#fff', fontSize: 22, fontWeight: '300', marginTop: -1 },
  list: { padding: 12, gap: 8 },
  card: { backgroundColor: '#2a2a2a', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: '#404040' },
  repostBanner: { fontSize: 11, color: '#b3b3b3', marginBottom: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarPlaceholder: { backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#b3b3b3', fontSize: 15, fontWeight: '600' },
  headerText: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  displayName: { fontSize: 14, fontWeight: '600', color: '#f2f2f2', flex: 1 },
  time: { fontSize: 11, color: '#b3b3b3' },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  errorText: { color: '#b3b3b3', fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#333', borderRadius: 8 },
  retryText: { color: '#f97316', fontSize: 14 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60 },
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
