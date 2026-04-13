/**
 * ThreadTree — thread tree visualization showing nested replies with indentation.
 *
 * Uses the useThreadQuery hook's rows/tree data to render a flat list
 * where each row is indented by its depth level.
 *
 * Mirrors web's ThreadTree adapted for React Native (FlatList instead of virtualizer).
 */
import { useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import type { FlatThreadRow } from '@core/threadTree';
import { useAuthor } from '../../hooks/useAuthor';
import { useBookmarks } from '../../hooks/useBookmarks';
import { NoteContent } from '../NoteContent';
import { NoteActions } from '../NoteActions';
import { SizeGuardedImage } from '../SizeGuardedImage';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';

// ============================================================================
// Thread note card
// ============================================================================

function ThreadNoteCard({
  event,
  depth,
  isTarget,
  isCollapsed,
  isBookmarked,
  onToggleBookmark,
  onToggleCollapse,
  onReply,
}: {
  event: NostrEvent;
  depth: number;
  isTarget: boolean;
  isCollapsed: boolean;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  onToggleCollapse: () => void;
  onReply: () => void;
}) {
  const { data } = useAuthor(event.pubkey);
  const displayName =
    data?.metadata?.display_name || data?.metadata?.name || genUserName(event.pubkey);
  const avatar = data?.metadata?.picture;
  const indent = Math.min(depth, 4) * 16;

  return (
    <View style={[styles.card, isTarget && styles.targetCard, { marginLeft: indent }]}>
      {/* Collapse toggle for nested replies */}
      {depth > 0 && (
        <TouchableOpacity onPress={onToggleCollapse} style={styles.collapseBar}>
          <View style={[styles.collapseLine, isCollapsed && styles.collapseLineActive]} />
        </TouchableOpacity>
      )}

      <View style={styles.cardContent}>
        {/* Header: avatar + name + time */}
        <View style={styles.cardHeader}>
          {avatar ? (
            <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarLetter}>{displayName[0]?.toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.headerText}>
            <Text style={styles.displayName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.time}>{formatTimeAgo(event.created_at)}</Text>
          </View>
        </View>

        {/* Content */}
        {!isCollapsed && (
          <>
            <NoteContent event={event} numberOfLines={isTarget ? undefined : 8} />
            <NoteActions
              event={event}
              onReply={onReply}
              isBookmarked={isBookmarked}
              onToggleBookmark={onToggleBookmark}
            />
          </>
        )}

        {isCollapsed && (
          <TouchableOpacity onPress={onToggleCollapse}>
            <Text style={styles.collapsedLabel}>Show replies...</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ============================================================================
// Main component
// ============================================================================

interface ThreadTreeProps {
  rows: FlatThreadRow[];
  targetId: string | null;
  collapsedIds: Set<string>;
  onToggleCollapse: (eventId: string) => void;
  onReply?: (event: NostrEvent) => void;
}

export function ThreadTree({
  rows,
  targetId,
  collapsedIds,
  onToggleCollapse,
  onReply,
}: ThreadTreeProps) {
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const flatListRef = useRef<FlatList<FlatThreadRow>>(null);

  // Scroll to target event on mount
  useEffect(() => {
    if (!targetId || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.node.event.id === targetId);
    if (idx >= 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
      }, 300);
    }
  }, [rows.length > 0, targetId]); // only on first load

  const renderRow = useCallback(
    ({ item }: { item: FlatThreadRow }) => (
      <ThreadNoteCard
        event={item.node.event}
        depth={item.depth}
        isTarget={item.node.event.id === targetId}
        isCollapsed={collapsedIds.has(item.node.event.id)}
        isBookmarked={isBookmarked(item.node.event.id)}
        onToggleBookmark={() => toggleBookmark(item.node.event.id)}
        onToggleCollapse={() => onToggleCollapse(item.node.event.id)}
        onReply={() => onReply?.(item.node.event)}
      />
    ),
    [targetId, collapsedIds, isBookmarked, toggleBookmark, onToggleCollapse, onReply],
  );

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({
          index: info.index,
          animated: true,
          viewPosition: 0.3,
        });
      }, 500);
    },
    [],
  );

  return (
    <FlatList
      ref={flatListRef}
      data={rows}
      keyExtractor={(item) => item.node.event.id}
      renderItem={renderRow}
      contentContainerStyle={styles.list}
      removeClippedSubviews
      onScrollToIndexFailed={onScrollToIndexFailed}
      ListEmptyComponent={
        <Text style={styles.emptyText}>Thread not found</Text>
      }
    />
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  list: { padding: 12, gap: 6 },
  card: {
    flexDirection: 'row',
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    overflow: 'hidden',
  },
  targetCard: { borderColor: '#f97316', borderWidth: 2 },
  collapseBar: {
    width: 20,
    alignItems: 'center',
    paddingTop: 14,
  },
  collapseLine: {
    width: 2,
    flex: 1,
    backgroundColor: '#404040',
    borderRadius: 1,
  },
  collapseLineActive: { backgroundColor: '#f97316' },
  cardContent: { flex: 1, padding: 14 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10,
  },
  avatar: { width: 32, height: 32, borderRadius: 16 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 13, fontWeight: '600' },
  headerText: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  displayName: { fontSize: 13, fontWeight: '600', color: '#f2f2f2', flex: 1 },
  time: { fontSize: 11, color: '#b3b3b3' },
  collapsedLabel: { color: '#f97316', fontSize: 12, marginTop: 4 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60 },
});
