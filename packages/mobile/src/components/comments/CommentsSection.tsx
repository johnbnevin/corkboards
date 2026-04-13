/**
 * CommentsSection — Full comments section with comment list and form.
 *
 * Port of packages/web/src/components/comments/CommentsSection.tsx for React Native.
 */
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useComments } from '../../hooks/useComments';
import { CommentForm } from './CommentForm';
import { Comment } from './Comment';

interface CommentsSectionProps {
  root: NostrEvent | URL;
  title?: string;
  emptyStateMessage?: string;
  emptyStateSubtitle?: string;
  limit?: number;
}

export function CommentsSection({
  root,
  title = 'Comments',
  emptyStateMessage = 'No comments yet',
  emptyStateSubtitle = 'Be the first to share your thoughts!',
  limit = 500,
}: CommentsSectionProps) {
  const { data: commentsData, isLoading, error } = useComments(root, limit);
  const comments = commentsData?.topLevelComments || [];

  if (error) {
    return (
      <View style={styles.container}>
        <View style={styles.errorState}>
          <Text style={styles.errorText}>Failed to load comments</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {!isLoading && (
          <Text style={styles.count}>({comments.length})</Text>
        )}
      </View>

      {/* Comment Form */}
      <CommentForm root={root} />

      {/* Comments List */}
      {isLoading ? (
        <View style={styles.loadingState}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeleton}>
              <View style={styles.skeletonHeader}>
                <View style={styles.skeletonAvatar} />
                <View style={styles.skeletonLines}>
                  <View style={[styles.skeletonLine, { width: 100 }]} />
                  <View style={[styles.skeletonLine, { width: 60 }]} />
                </View>
              </View>
              <View style={[styles.skeletonLine, { width: '100%', height: 40 }]} />
            </View>
          ))}
        </View>
      ) : comments.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>{emptyStateMessage}</Text>
          <Text style={styles.emptySubtitle}>{emptyStateSubtitle}</Text>
        </View>
      ) : (
        <View style={styles.commentList}>
          {comments.map((comment) => (
            <Comment
              key={comment.id}
              root={root}
              comment={comment}
              limit={limit}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    padding: 14,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: { fontSize: 17, fontWeight: '600', color: '#f2f2f2' },
  count: { fontSize: 13, color: '#b3b3b3' },
  errorState: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  errorText: { color: '#b3b3b3', fontSize: 14 },
  loadingState: { gap: 12 },
  skeleton: {
    backgroundColor: '#333',
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  skeletonHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  skeletonAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#444',
  },
  skeletonLines: { gap: 4 },
  skeletonLine: {
    height: 12,
    borderRadius: 4,
    backgroundColor: '#444',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 6,
  },
  emptyTitle: { color: '#666', fontSize: 16, fontWeight: '500' },
  emptySubtitle: { color: '#555', fontSize: 13 },
  commentList: { gap: 12 },
});
