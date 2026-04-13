/**
 * Comment — Single comment display with author info, time, content,
 * and nested reply support.
 *
 * Port of packages/web/src/components/comments/Comment.tsx for React Native.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '../../hooks/useAuthor';
import { useComments } from '../../hooks/useComments';
import { NoteContent } from '../NoteContent';
import { SizeGuardedImage } from '../SizeGuardedImage';
import { CommentForm } from './CommentForm';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';

interface CommentProps {
  root: NostrEvent | URL;
  comment: NostrEvent;
  depth?: number;
  maxDepth?: number;
  limit?: number;
}

export function Comment({ root, comment, depth = 0, maxDepth = 3, limit }: CommentProps) {
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [showReplies, setShowReplies] = useState(depth < 2);

  const { data: author } = useAuthor(comment.pubkey);
  const { data: commentsData } = useComments(root, limit);

  const metadata = author?.metadata;
  const displayName = metadata?.display_name || metadata?.name || genUserName(comment.pubkey);
  const avatar = metadata?.picture;

  const replies = commentsData?.getDirectReplies(comment.id) || [];
  const hasReplies = replies.length > 0;

  return (
    <View style={[styles.wrapper, depth > 0 && styles.nested]}>
      <View style={styles.card}>
        {/* Header */}
        <View style={styles.header}>
          {avatar ? (
            <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarLetter}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.headerInfo}>
            <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.time}>{formatTimeAgo(comment.created_at)}</Text>
          </View>
        </View>

        {/* Content */}
        <View style={styles.content}>
          <NoteContent event={comment} />
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={() => setShowReplyForm(!showReplyForm)}
            style={styles.actionBtn}
          >
            <Text style={styles.actionText}>Reply</Text>
          </TouchableOpacity>

          {hasReplies && (
            <TouchableOpacity
              onPress={() => setShowReplies(!showReplies)}
              style={styles.actionBtn}
            >
              <Text style={styles.actionText}>
                {showReplies ? 'Hide' : 'Show'} {replies.length}{' '}
                {replies.length === 1 ? 'reply' : 'replies'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Reply Form */}
      {showReplyForm && (
        <View style={styles.replyForm}>
          <CommentForm
            root={root}
            reply={comment}
            onSuccess={() => setShowReplyForm(false)}
            placeholder="Write a reply..."
            compact
          />
        </View>
      )}

      {/* Nested Replies */}
      {hasReplies && showReplies && depth < maxDepth && (
        <View style={styles.replies}>
          {replies.map((reply) => (
            <Comment
              key={reply.id}
              root={root}
              comment={reply}
              depth={depth + 1}
              maxDepth={maxDepth}
              limit={limit}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 8 },
  nested: {
    marginLeft: 24,
    borderLeftWidth: 2,
    borderLeftColor: '#404040',
    paddingLeft: 12,
  },
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#404040',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  avatar: { width: 32, height: 32, borderRadius: 16 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 13, fontWeight: '600' },
  headerInfo: { flex: 1 },
  displayName: { fontSize: 13, fontWeight: '600', color: '#f2f2f2' },
  time: { fontSize: 11, color: '#b3b3b3', marginTop: 1 },
  content: { marginBottom: 8 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  actionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  actionText: { color: '#b3b3b3', fontSize: 12 },
  replyForm: { marginLeft: 24 },
  replies: { gap: 8 },
});
