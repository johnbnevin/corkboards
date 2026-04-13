/**
 * Thread screen — displays a full conversation thread with nested replies.
 *
 * Uses ThreadPanel as the main container. Wires up ZapDialog and ProfileModal
 * for tapping author names and zap actions on replies.
 * Mirrors web's thread panel in MultiColumnClient.
 */
import { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  FlatList,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useThreadQuery } from '../hooks/useThreadQuery';
import { useAuthor } from '../hooks/useAuthor';
import { useProfileModal, TappableProfile } from '../components/ProfileModal';
import { ThreadReplyRow } from '../components/thread/ThreadReplyRow';
import { InlineReplyComposer } from '../components/thread/InlineReplyComposer';
import { ZapDialog } from '../components/ZapDialog';
import { NoteContent } from '../components/NoteContent';
import { SizeGuardedImage } from '../components/SizeGuardedImage';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';
import type { FlatThreadRow } from '@core/threadTree';

// ============================================================================
// Ancestor chain — compact display of parent notes above the target
// ============================================================================

function AncestorNote({ event, onPress }: { event: NostrEvent; onPress?: () => void }) {
  const { data } = useAuthor(event.pubkey);
  const { openProfile } = useProfileModal();
  const displayName = data?.metadata?.display_name || data?.metadata?.name || genUserName(event.pubkey);
  const avatar = data?.metadata?.picture;

  return (
    <TouchableOpacity style={styles.ancestorCard} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.ancestorConnector}>
        <View style={styles.connectorLine} />
      </View>
      <View style={styles.ancestorContent}>
        <View style={styles.ancestorHeader}>
          <TappableProfile pubkey={event.pubkey}>
            {avatar ? (
              <SizeGuardedImage uri={avatar} style={styles.ancestorAvatar} type="avatar" />
            ) : (
              <View style={[styles.ancestorAvatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarLetter}>{displayName[0]?.toUpperCase()}</Text>
              </View>
            )}
          </TappableProfile>
          <TappableProfile pubkey={event.pubkey}>
            <Text style={styles.ancestorName} numberOfLines={1}>{displayName}</Text>
          </TappableProfile>
          <Text style={styles.ancestorTime}>{formatTimeAgo(event.created_at)}</Text>
        </View>
        <NoteContent event={event} numberOfLines={3} />
      </View>
    </TouchableOpacity>
  );
}

// ============================================================================
// ThreadScreen
// ============================================================================

interface ThreadScreenProps {
  eventId: string;
  onBack: () => void;
  onNavigateThread?: (eventId: string) => void;
}

export function ThreadScreen({ eventId, onBack, onNavigateThread }: ThreadScreenProps) {
  const {
    rows,
    targetEvent,
    allEvents,
    rootId,
    isLoading,
    error,
    collapsedIds,
    toggleCollapse,
    injectReply,
    refetch,
  } = useThreadQuery(eventId);
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);

  const totalReplies = rows.length > 0 ? rows.length - 1 : 0;

  // Build ancestor chain: notes from root to the target's parent
  const ancestors = useMemo(() => {
    if (!targetEvent || !allEvents || allEvents.length === 0) return [];
    const eventMap = new Map(allEvents.map(e => [e.id, e]));
    const chain: NostrEvent[] = [];
    let current = targetEvent;

    // Walk up the reply chain
    while (current) {
      const eTags = current.tags.filter(t => t[0] === 'e');
      const replyTag = eTags.find(t => t[3] === 'reply') ?? eTags.find(t => t[3] === 'root');
      const parentTag = replyTag ?? (eTags.length > 0 ? eTags[0] : null);
      if (!parentTag || parentTag[1] === current.id) break;
      const parent = eventMap.get(parentTag[1]);
      if (!parent || parent.id === current.id) break;
      chain.unshift(parent);
      current = parent;
    }

    return chain;
  }, [targetEvent, allEvents]);

  const handleReply = useCallback((event: NostrEvent) => {
    setReplyTarget(event);
  }, []);

  const handleReplyPublished = useCallback(
    (event: NostrEvent) => {
      injectReply(event);
      setReplyTarget(null);
    },
    [injectReply],
  );

  const handleZap = useCallback((event: NostrEvent) => {
    setZapTarget(event);
  }, []);

  const handleQuote = useCallback((event: NostrEvent) => {
    // For now, start a reply with a quote tag
    setReplyTarget(event);
  }, []);

  // Render ancestor + rows as a combined list
  const listData = useMemo(() => {
    const items: { type: 'ancestor'; event: NostrEvent }[] | { type: 'row'; row: FlatThreadRow }[] = [];
    for (const a of ancestors) {
      (items as any[]).push({ type: 'ancestor', event: a });
    }
    for (const r of rows) {
      (items as any[]).push({ type: 'row', row: r });
    }
    return items as ({ type: 'ancestor'; event: NostrEvent } | { type: 'row'; row: FlatThreadRow })[];
  }, [ancestors, rows]);

  const renderItem = useCallback(
    ({ item }: { item: typeof listData[number] }) => {
      if (item.type === 'ancestor') {
        return <AncestorNote event={item.event} onPress={() => onNavigateThread?.(item.event.id)} />;
      }
      const { row } = item;
      return (
        <ThreadReplyRow
          node={row.node}
          depth={row.depth}
          isTarget={row.node.event.id === eventId}
          isCollapsed={collapsedIds.has(row.node.event.id)}
          onToggleCollapse={toggleCollapse}
          onReply={handleReply}
          onQuote={handleQuote}
          onZap={handleZap}
        />
      );
    },
    [eventId, collapsedIds, toggleCollapse, handleReply, handleQuote, handleZap, onNavigateThread],
  );

  const keyExtractor = useCallback(
    (item: typeof listData[number]) =>
      item.type === 'ancestor' ? `anc-${item.event.id}` : item.row.node.event.id,
    [],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'<'} Back</Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <Text style={styles.title}>Thread</Text>
          {!isLoading && totalReplies > 0 && (
            <Text style={styles.replyCount}>
              ({totalReplies} {totalReplies === 1 ? 'reply' : 'replies'})
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={() => refetch()} style={styles.refreshBtn}>
          {isLoading ? (
            <ActivityIndicator color="#b3b3b3" size="small" />
          ) : (
            <Text style={styles.refreshText}>Refresh</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Content */}
      {isLoading && rows.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" size="large" />
          <Text style={styles.loadingText}>Loading thread...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => refetch()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : listData.length > 0 ? (
        <FlatList
          data={listData}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          removeClippedSubviews
          ListEmptyComponent={
            <Text style={styles.emptyText}>No thread data found.</Text>
          }
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No thread data found.</Text>
        </View>
      )}

      {/* Inline reply composer */}
      {replyTarget && (
        <InlineReplyComposer
          replyTo={replyTarget}
          onCancel={() => setReplyTarget(null)}
          onPublished={handleReplyPublished}
        />
      )}

      {/* Zap dialog */}
      <ZapDialog
        note={zapTarget}
        visible={!!zapTarget}
        onClose={() => setZapTarget(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  backBtn: { paddingRight: 8 },
  backText: { color: '#b3b3b3', fontSize: 16 },
  headerRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#f2f2f2' },
  replyCount: { fontSize: 13, color: '#b3b3b3' },
  refreshBtn: { paddingLeft: 8 },
  refreshText: { color: '#b3b3b3', fontSize: 13 },
  list: { padding: 12, gap: 6 },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  errorText: { color: '#b3b3b3', fontSize: 14, textAlign: 'center', marginBottom: 8 },
  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  retryText: { color: '#f2f2f2', fontSize: 13 },
  emptyText: { color: '#666', fontSize: 14, textAlign: 'center', marginTop: 60 },

  // Ancestor chain
  ancestorCard: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  ancestorConnector: {
    width: 20,
    alignItems: 'center',
    paddingTop: 4,
  },
  connectorLine: {
    width: 2,
    flex: 1,
    backgroundColor: '#666',
    borderRadius: 1,
  },
  ancestorContent: {
    flex: 1,
    backgroundColor: '#252525',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  ancestorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  ancestorAvatar: { width: 20, height: 20, borderRadius: 10 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 9, fontWeight: '600' },
  ancestorName: { fontSize: 12, fontWeight: '600', color: '#ccc', flex: 1 },
  ancestorTime: { fontSize: 10, color: '#666' },
});
