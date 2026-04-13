/**
 * FeedGrid — FlatList-based feed renderer for mobile.
 *
 * Single column layout using FlatList with pull-to-refresh, loading states,
 * and empty state handling.
 *
 * Mobile equivalent of packages/web/src/components/FeedGrid.tsx.
 */
import React, { useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import type { FlatList as FlatListType } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { NoteCard } from './NoteCard';

interface FeedGridProps {
  /** Notes to display */
  notes: NostrEvent[];
  /** True while the initial data query is in-flight */
  isLoading: boolean;
  /** True while refreshing */
  isRefreshing?: boolean;
  /** Called on pull-to-refresh */
  onRefresh?: () => void;
  /** Called when a note's thread is opened */
  onViewThread?: (eventId: string) => void;
  /** Called when reply is tapped */
  onReply?: (event: NostrEvent) => void;
  /** Called when profile is tapped */
  onViewProfile?: (pubkey: string) => void;
  /** Check if a note is bookmarked */
  isBookmarked?: (noteId: string) => boolean;
  /** Toggle bookmark for a note */
  onToggleBookmark?: (noteId: string) => void;
  /** Map of parent notes for reply context */
  parentNotes?: Record<string, NostrEvent | null>;
  /** IDs of freshly-loaded notes */
  freshNoteIds?: Set<string>;
  /** Whether there are older notes still available */
  hasMore?: boolean;
  /** Called when load more is triggered */
  onLoadMore?: () => void;
  /** True while loading older notes */
  isLoadingMore?: boolean;
  /** Empty state message */
  emptyMessage?: string;
  /** Loading state message */
  loadingMessage?: string;
  /** When true, a media filter is active */
  mediaFilterActive?: boolean;
}

export const FeedGrid = React.memo(function FeedGrid({
  notes,
  isLoading,
  isRefreshing = false,
  onRefresh,
  onViewThread,
  onReply,
  onViewProfile,
  isBookmarked,
  onToggleBookmark,
  parentNotes,
  freshNoteIds,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
  emptyMessage = 'No notes found',
  loadingMessage = 'Loading...',
  mediaFilterActive = false,
}: FeedGridProps) {
  const flatListRef = useRef<FlatListType<NostrEvent>>(null);

  const renderNote = useCallback(
    ({ item }: { item: NostrEvent }) => {
      const parentNote = parentNotes?.[
        // Find parent event ID from e-tags
        item.tags.find(t => t[0] === 'e' && t[3] === 'reply')?.[1]
        || item.tags.find(t => t[0] === 'e')?.[1]
        || ''
      ];

      return (
        <NoteCard
          event={item}
          onReply={onReply}
          isBookmarked={isBookmarked?.(item.id) ?? false}
          onToggleBookmark={() => onToggleBookmark?.(item.id)}
          onViewProfile={onViewProfile}
          onViewThread={onViewThread}
          parentNote={parentNote}
          isFresh={freshNoteIds?.has(item.id) ?? false}
          mediaFilterActive={mediaFilterActive}
        />
      );
    },
    [onReply, isBookmarked, onToggleBookmark, onViewProfile, onViewThread, parentNotes, freshNoteIds, mediaFilterActive],
  );

  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore && onLoadMore) {
      onLoadMore();
    }
  }, [hasMore, isLoadingMore, onLoadMore]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#a855f7" size="large" />
        <Text style={styles.loadingText}>{loadingMessage}</Text>
      </View>
    );
  }

  return (
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
      updateCellsBatchingPeriod={50}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.5}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor="#b3b3b3"
          />
        ) : undefined
      }
      ListEmptyComponent={
        <Text style={styles.emptyText}>{emptyMessage}</Text>
      }
      ListFooterComponent={
        isLoadingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator color="#a855f7" size="small" />
            <Text style={styles.footerText}>Loading more...</Text>
          </View>
        ) : hasMore ? (
          <TouchableOpacity style={styles.loadMoreBtn} onPress={onLoadMore}>
            <Text style={styles.loadMoreText}>Load more</Text>
          </TouchableOpacity>
        ) : null
      }
      ItemSeparatorComponent={() => <View style={styles.separator} />}
    />
  );
});

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 40,
  },
  loadingText: {
    color: '#b3b3b3',
    fontSize: 14,
  },
  list: {
    padding: 12,
    paddingBottom: 80,
  },
  separator: {
    height: 8,
  },
  emptyText: {
    color: '#666',
    textAlign: 'center',
    marginTop: 60,
    fontSize: 14,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  footerText: {
    color: '#b3b3b3',
    fontSize: 13,
  },
  loadMoreBtn: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  loadMoreText: {
    color: '#a855f7',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
});
