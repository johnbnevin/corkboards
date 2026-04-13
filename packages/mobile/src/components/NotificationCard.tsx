/**
 * NotificationCard -- displays a single Nostr notification with type icon,
 * author avatar/name, content preview, and relative time.
 *
 * Port of packages/web/src/components/NotificationCard.tsx for React Native.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '../hooks/useAuthor';
import { useCollapsedNotes } from '../hooks/useCollapsedNotes';
import { type NotificationItem, getZapAmountSats } from '../hooks/useNotifications';
import { SizeGuardedImage } from './SizeGuardedImage';
import { NoteContent } from './NoteContent';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';
import { visibleLength, findVisibleCutoff } from '@core/textTruncation';

// ---- Type config ----

const TYPE_LABELS: Record<string, string> = {
  reply: 'replied',
  mention: 'mentioned you',
  repost: 'reposted',
  reaction: 'reacted',
  zap: 'zapped',
};

const TYPE_ICONS: Record<string, string> = {
  reply: '\u{1F4AC}',
  mention: '\u{1F4E2}',
  repost: '\u21BB',
  reaction: '\u2665',
  zap: '\u26A1',
};

const TYPE_COLORS: Record<string, string> = {
  reply: '#3b82f6',
  mention: '#a855f7',
  repost: '#22c55e',
  reaction: '#ec4899',
  zap: '#f59e0b',
};

// ---- Expandable content ----

function ExpandableContent({ event }: { event: NostrEvent }) {
  const [expanded, setExpanded] = useState(false);
  const visLen = visibleLength(event.content);
  const canExpand = visLen > 150;

  const displayEvent = useMemo(() => {
    if (expanded || !canExpand) return event;
    return {
      ...event,
      content: event.content.slice(0, findVisibleCutoff(event.content, 150)).trimEnd() + '\u2026',
    };
  }, [event, expanded, canExpand]);

  return (
    <View>
      <NoteContent event={displayEvent} numberOfLines={expanded ? undefined : 6} />
      {canExpand && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)}>
          <Text style={styles.expandBtn}>{expanded ? 'Show less' : 'Show more'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ---- Main component ----

interface NotificationCardProps {
  notification: NotificationItem;
  onViewThread?: (eventId: string) => void;
}

export const NotificationCard = React.memo(function NotificationCard({
  notification,
  onViewThread,
}: NotificationCardProps) {
  const { event, type, targetEventId, senderPubkey } = notification;
  const { isCollapsed, toggleCollapsed, dismiss, isSoftDismissed, canUndoDismiss, undoDismiss } = useCollapsedNotes();

  // For zaps, use the real sender pubkey
  const actorPubkey = (type === 'zap' && senderPubkey) ? senderPubkey : event.pubkey;
  const { data: actor } = useAuthor(actorPubkey);
  const actorName = actor?.metadata?.display_name || actor?.metadata?.name || genUserName(actorPubkey);
  const actorAvatar = actor?.metadata?.picture;
  const timeAgo = useMemo(() => formatTimeAgo(event.created_at), [event.created_at]);

  // Reaction content
  const reactionEmoji = useMemo(() => {
    if (type !== 'reaction') return null;
    const content = event.content.trim();
    if (content === '+' || !content) return '\u2764\uFE0F';
    if (content === '-') return '\u{1F44E}';
    return content;
  }, [type, event.content]);

  // Zap amount
  const zapSats = useMemo(() => getZapAmountSats(event), [event]);
  const zapLabel = zapSats ? ` ${zapSats.toLocaleString()} sats` : '';

  const label = type === 'zap' && zapSats
    ? `zapped ${zapSats.toLocaleString()} sats`
    : TYPE_LABELS[type] || type;

  const threadTargetId = (type === 'reaction' || type === 'repost' || type === 'zap')
    ? (targetEventId || event.id)
    : event.id;

  const collapsed = isCollapsed(event.id);
  const softDismissed = isSoftDismissed(event.id);

  // Soft-dismissed placeholder
  if (softDismissed) {
    const canUndo = canUndoDismiss(event.id);
    return (
      <TouchableOpacity
        style={styles.placeholder}
        onPress={canUndo ? () => undoDismiss(event.id) : undefined}
        disabled={!canUndo}
      >
        <Text style={styles.placeholderText}>{canUndo ? 'undo' : 'dismissed'}</Text>
      </TouchableOpacity>
    );
  }

  // Collapsed placeholder
  if (collapsed) {
    return (
      <TouchableOpacity
        style={styles.placeholder}
        onPress={() => toggleCollapsed(event.id)}
      >
        <Text style={styles.placeholderText}>saved for later</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.7}
      onPress={() => onViewThread?.(threadTargetId)}
    >
      {/* Corner action buttons */}
      <View style={styles.cornerRow}>
        <TouchableOpacity
          style={styles.saveCorner}
          onPress={() => toggleCollapsed(event.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <View style={styles.greenTriangle} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.dismissCorner}
          onPress={() => dismiss(event.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <View style={styles.redTriangle} />
        </TouchableOpacity>
      </View>

      {/* Header: actor + action */}
      <View style={styles.header}>
        {actorAvatar ? (
          <SizeGuardedImage uri={actorAvatar} style={styles.avatar} type="avatar" />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Text style={styles.avatarLetter}>{actorName[0]?.toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.actorName} numberOfLines={1}>{actorName}</Text>
        <Text style={[styles.actionLabel, { color: TYPE_COLORS[type] || '#b3b3b3' }]}>
          {TYPE_ICONS[type] || ''} {label}
        </Text>
        <Text style={styles.time}>{timeAgo}</Text>
      </View>

      {/* Content: reply/mention text */}
      {(type === 'reply' || type === 'mention') && (
        <View style={styles.contentSection}>
          <ExpandableContent event={event} />
        </View>
      )}

      {/* Reaction emoji standalone */}
      {type === 'reaction' && reactionEmoji && (
        <Text style={styles.reactionEmoji}>{reactionEmoji}</Text>
      )}

      {/* Repost comment */}
      {type === 'repost' && event.content && (() => {
        try { JSON.parse(event.content); return null; } catch { /* not JSON */ }
        return event.content.trim() ? (
          <Text style={styles.repostComment}>"{event.content.trim()}"</Text>
        ) : null;
      })()}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    paddingTop: 24,
    borderWidth: 1,
    borderColor: '#404040',
  },
  placeholder: {
    backgroundColor: 'transparent',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    borderStyle: 'dashed',
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  placeholderText: {
    color: '#666',
    fontSize: 11,
  },

  cornerRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  saveCorner: {
    width: 36,
    height: 36,
  },
  dismissCorner: {
    width: 36,
    height: 36,
    alignItems: 'flex-end',
  },
  greenTriangle: {
    width: 0,
    height: 0,
    borderTopWidth: 36,
    borderRightWidth: 36,
    borderTopColor: '#22c55e',
    borderRightColor: 'transparent',
    borderTopLeftRadius: 10,
  },
  redTriangle: {
    width: 0,
    height: 0,
    borderTopWidth: 36,
    borderLeftWidth: 36,
    borderTopColor: '#ef4444',
    borderLeftColor: 'transparent',
    borderTopRightRadius: 10,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#b3b3b3',
    fontSize: 10,
    fontWeight: '600',
  },
  actorName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f2f2f2',
    flexShrink: 1,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  time: {
    fontSize: 10,
    color: '#666',
    marginLeft: 'auto',
  },

  contentSection: {
    marginTop: 8,
  },

  reactionEmoji: {
    fontSize: 28,
    marginTop: 8,
  },

  repostComment: {
    fontSize: 13,
    color: '#b3b3b3',
    fontStyle: 'italic',
    marginTop: 8,
  },

  expandBtn: {
    color: '#a855f7',
    fontSize: 12,
    marginTop: 4,
  },
});
