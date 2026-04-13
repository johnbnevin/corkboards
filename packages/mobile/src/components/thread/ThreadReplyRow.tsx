/**
 * ThreadReplyRow — Individual reply row with avatar, author, time, content,
 * and action buttons (reply, bookmark, zap, quote, repost).
 *
 * Port of packages/web/src/components/thread/ThreadReplyRow.tsx for React Native.
 */
import { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ThreadNode } from '@core/threadTree';
import { useAuthor } from '../../hooks/useAuthor';
import { useBookmarks } from '../../hooks/useBookmarks';
import { NoteContent } from '../NoteContent';
import { NoteActions } from '../NoteActions';
import { SizeGuardedImage } from '../SizeGuardedImage';
import { ThreadContent } from './ThreadContent';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';

export interface ThreadReplyRowProps {
  node: ThreadNode;
  depth: number;
  isTarget: boolean;
  isCollapsed: boolean;
  onToggleCollapse: (eventId: string) => void;
  onReply?: (event: NostrEvent) => void;
  onQuote?: (event: NostrEvent) => void;
  onRepost?: (event: NostrEvent) => void;
  onZap?: (event: NostrEvent) => void;
}

export const ThreadReplyRow = memo(function ThreadReplyRow({
  node,
  depth,
  isTarget,
  isCollapsed,
  onToggleCollapse,
  onReply,
  onQuote,
  onRepost,
  onZap,
}: ThreadReplyRowProps) {
  const { event, children: childNodes } = node;
  const { data: author } = useAuthor(event.pubkey);
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const metadata = author?.metadata;
  const displayName = metadata?.display_name || metadata?.name || genUserName(event.pubkey);
  const avatar = metadata?.picture;
  const hasReplies = childNodes.length > 0;
  const isReaction = event.kind === 7;
  const indent = Math.min(depth, 4) * 12;

  return (
    <View style={{ paddingLeft: depth > 0 ? indent : 0 }}>
      <View style={depth > 0 ? styles.indentedWrapper : undefined}>
        <View style={[
          styles.card,
          isTarget && styles.targetCard,
        ]}>
          {/* Header */}
          <View style={styles.headerRow}>
            {avatar ? (
              <SizeGuardedImage
                uri={avatar}
                style={[styles.avatar, isTarget && styles.avatarTarget]}
                type="avatar"
              />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder, isTarget && styles.avatarTarget]}>
                <Text style={styles.avatarLetter}>
                  {displayName.slice(0, 2).toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={styles.displayName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.separator}>-</Text>
            <Text style={styles.time}>{formatTimeAgo(event.created_at)}</Text>

            {hasReplies && (
              <TouchableOpacity
                onPress={() => onToggleCollapse(event.id)}
                style={styles.collapseBtn}
              >
                <Text style={styles.collapseText}>
                  {isCollapsed ? `+ ${childNodes.length}` : '-'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Content */}
          {!isReaction && !isCollapsed && (
            <View style={styles.contentArea}>
              <ThreadContent event={event} isTarget={isTarget} />
            </View>
          )}

          {isCollapsed && (
            <TouchableOpacity onPress={() => onToggleCollapse(event.id)}>
              <Text style={styles.collapsedLabel}>Show replies...</Text>
            </TouchableOpacity>
          )}

          {/* Actions */}
          {!isCollapsed && (
            <View style={styles.actionsRow}>
              {onReply && (
                <TouchableOpacity onPress={() => onReply(event)} style={styles.actionBtn}>
                  <Text style={styles.actionText}>Reply</Text>
                </TouchableOpacity>
              )}
              {onQuote && (
                <TouchableOpacity onPress={() => onQuote(event)} style={styles.actionBtn}>
                  <Text style={styles.actionText}>Quote</Text>
                </TouchableOpacity>
              )}
              {onRepost && (
                <TouchableOpacity onPress={() => onRepost(event)} style={styles.actionBtn}>
                  <Text style={styles.actionText}>Repost</Text>
                </TouchableOpacity>
              )}
              {onZap && (
                <TouchableOpacity onPress={() => onZap(event)} style={styles.actionBtn}>
                  <Text style={[styles.actionText, styles.zapText]}>Zap</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => toggleBookmark(event.id)}
                style={styles.actionBtn}
              >
                <Text style={[
                  styles.actionText,
                  isBookmarked(event.id) && styles.bookmarkedText,
                ]}>
                  {isBookmarked(event.id) ? 'Saved' : 'Save'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  indentedWrapper: {
    borderLeftWidth: 1,
    borderLeftColor: '#404040',
    paddingLeft: 12,
  },
  card: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  targetCard: {
    backgroundColor: 'rgba(249, 115, 22, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(249, 115, 22, 0.3)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  avatar: { width: 16, height: 16, borderRadius: 8 },
  avatarTarget: { width: 20, height: 20, borderRadius: 10 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 8, fontWeight: '600' },
  displayName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#f2f2f2',
    flexShrink: 1,
  },
  separator: { color: '#666', fontSize: 12 },
  time: { color: '#b3b3b3', fontSize: 11 },
  collapseBtn: {
    marginLeft: 'auto',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  collapseText: { color: '#b3b3b3', fontSize: 11 },
  contentArea: { marginTop: 2, paddingLeft: 22 },
  collapsedLabel: { color: '#f97316', fontSize: 12, marginTop: 4, paddingLeft: 22 },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    paddingLeft: 22,
  },
  actionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  actionText: {
    fontSize: 11,
    color: '#b3b3b3',
  },
  zapText: { color: '#f59e0b' },
  bookmarkedText: { color: '#f97316' },
});
