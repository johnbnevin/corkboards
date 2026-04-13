/**
 * NoteCard — card wrapper for a single note in the feed.
 *
 * Shows author avatar, display name, time, content (via NoteContent),
 * and action buttons (via NoteActions). Handles reposts with a header banner.
 * Mobile equivalent of packages/web/src/components/NoteCard.tsx.
 */
import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAuthor } from '../hooks/useAuthor';
import { NoteContent } from './NoteContent';
import { NoteActions } from './NoteActions';
import { SizeGuardedImage } from './SizeGuardedImage';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';
import { visibleLength, findVisibleCutoff } from '@core/textTruncation';

// ============================================================================
// Repost author name — shows the actual author for reposts
// ============================================================================

function RepostAuthorName({ event }: { event: NostrEvent }) {
  const { data } = useAuthor(event.pubkey);
  const name = data?.metadata?.display_name || data?.metadata?.name || genUserName(event.pubkey);
  return <Text style={styles.displayName} numberOfLines={1}>{name}</Text>;
}

// ============================================================================
// Parent context — compact display of the note being replied to
// ============================================================================

function ParentContext({ parentNote, onViewThread }: { parentNote: NostrEvent; onViewThread?: (id: string) => void }) {
  const { data: author } = useAuthor(parentNote.pubkey);
  const displayName = author?.metadata?.display_name || author?.metadata?.name || genUserName(parentNote.pubkey);
  const avatar = author?.metadata?.picture;

  const preview = useMemo(() => {
    const visLen = visibleLength(parentNote.content);
    if (visLen > 100) {
      return parentNote.content.slice(0, findVisibleCutoff(parentNote.content, 100)).trimEnd() + '...';
    }
    return parentNote.content;
  }, [parentNote.content]);

  return (
    <TouchableOpacity
      style={styles.parentContext}
      activeOpacity={0.7}
      onPress={() => onViewThread?.(parentNote.id)}
    >
      <View style={styles.parentHeader}>
        <Text style={styles.parentReplyIcon}>{'<'}</Text>
        <Text style={styles.parentLabel}>Replying to</Text>
        {avatar ? (
          <SizeGuardedImage uri={avatar} style={styles.parentAvatar} type="avatar" />
        ) : (
          <View style={[styles.parentAvatar, styles.parentAvatarPlaceholder]}>
            <Text style={styles.parentAvatarLetter}>{displayName[0]?.toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.parentName} numberOfLines={1}>{displayName}</Text>
      </View>
      <Text style={styles.parentPreview} numberOfLines={2}>{preview.replace(/<[^>]*>/g, '')}</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// NoteCard
// ============================================================================

interface NoteCardProps {
  event: NostrEvent;
  onReply?: (e: NostrEvent) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onViewProfile?: (pubkey: string) => void;
  onViewThread?: (eventId: string) => void;
  /** Parent note for replies (the note being replied to) */
  parentNote?: NostrEvent | null;
  /** Whether this note was recently added (for highlighting) */
  isFresh?: boolean;
  /** When true, a media filter is active — auto-expand and unblur media */
  mediaFilterActive?: boolean;
}

export function NoteCard({
  event,
  onReply,
  isBookmarked = false,
  onToggleBookmark,
  onViewProfile,
  onViewThread,
  parentNote,
  isFresh = false,
  mediaFilterActive = false,
}: NoteCardProps) {
  const isRepost = event.kind === 6;
  const [expanded, setExpanded] = useState(false);

  // For reposts, parse the inner event
  const displayEvent = useMemo(() => {
    if (!isRepost) return event;
    try {
      const inner = JSON.parse(event.content);
      if (
        inner &&
        inner.id &&
        inner.pubkey &&
        typeof inner.kind === 'number' &&
        typeof inner.content === 'string'
      ) return inner as NostrEvent;
    } catch { /* not JSON */ }
    return event;
  }, [event, isRepost]);

  const { data: repostAuthorData } = useAuthor(event.pubkey);
  const { data } = useAuthor(displayEvent.pubkey);
  const displayName =
    data?.metadata?.display_name || data?.metadata?.name || genUserName(displayEvent.pubkey);
  const repostName =
    repostAuthorData?.metadata?.display_name || repostAuthorData?.metadata?.name || genUserName(event.pubkey);
  const avatar = data?.metadata?.picture;

  // Check if this is a reply with a parent context
  const isReply = !!parentNote;

  // Long content handling
  const visLen = useMemo(() => visibleLength(displayEvent.content), [displayEvent.content]);
  const isLong = visLen > 300;

  const truncatedEvent = useMemo(() => {
    if (!isLong || expanded || mediaFilterActive) return displayEvent;
    const cutoff = findVisibleCutoff(displayEvent.content, 300);
    return { ...displayEvent, content: displayEvent.content.slice(0, cutoff).trimEnd() + '...' };
  }, [displayEvent, isLong, expanded, mediaFilterActive]);

  return (
    <TouchableOpacity
      style={[styles.card, isFresh && styles.freshCard]}
      onPress={() => onViewThread?.(displayEvent.id)}
      activeOpacity={0.8}
    >
      {/* Repost banner */}
      {isRepost && (
        <Text style={styles.repostBanner}>{'↻'} {repostName} reposted</Text>
      )}

      {/* Reply context */}
      {isReply && parentNote && (
        <ParentContext parentNote={parentNote} onViewThread={onViewThread} />
      )}

      {/* Card header: avatar, name, time */}
      <View style={styles.cardHeader}>
        <TouchableOpacity onPress={() => onViewProfile?.(displayEvent.pubkey)}>
          {avatar ? (
            <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarLetter}>{displayName[0]?.toUpperCase()}</Text>
            </View>
          )}
        </TouchableOpacity>
        <View style={styles.headerText}>
          <TouchableOpacity
            onPress={() => onViewProfile?.(displayEvent.pubkey)}
            style={{ flex: 1 }}
          >
            {isRepost ? (
              <RepostAuthorName event={displayEvent} />
            ) : (
              <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.time}>{formatTimeAgo(displayEvent.created_at)}</Text>
        </View>
      </View>

      {/* Note content */}
      <NoteContent event={truncatedEvent} numberOfLines={isLong && !expanded && !mediaFilterActive ? 12 : undefined} />

      {/* Show more / show less */}
      {isLong && !mediaFilterActive && (
        <TouchableOpacity
          onPress={(e) => { e.stopPropagation?.(); setExpanded(!expanded); }}
          style={styles.expandButton}
        >
          <Text style={styles.expandText}>{expanded ? 'Show less' : 'Show more'}</Text>
        </TouchableOpacity>
      )}

      {/* Action bar */}
      <NoteActions
        event={displayEvent}
        onReply={() => onReply?.(displayEvent)}
        isBookmarked={isBookmarked}
        onToggleBookmark={onToggleBookmark}
      />
    </TouchableOpacity>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#404040',
  },
  freshCard: {
    borderColor: '#a855f7',
    borderWidth: 1.5,
  },
  repostBanner: {
    fontSize: 11,
    color: '#b3b3b3',
    marginBottom: 6,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10,
  },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#b3b3b3', fontSize: 15, fontWeight: '600' },
  headerText: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  displayName: { fontSize: 14, fontWeight: '600', color: '#f2f2f2', flex: 1 },
  time: { fontSize: 11, color: '#b3b3b3' },
  expandButton: { marginTop: 4 },
  expandText: { color: '#a855f7', fontSize: 12 },
  // Parent context
  parentContext: {
    marginBottom: 10,
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#666',
  },
  parentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  parentReplyIcon: { color: '#999', fontSize: 10 },
  parentLabel: { color: '#999', fontSize: 11 },
  parentAvatar: { width: 16, height: 16, borderRadius: 8 },
  parentAvatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  parentAvatarLetter: { color: '#a855f7', fontSize: 8, fontWeight: '600' },
  parentName: { color: '#ccc', fontSize: 11, fontWeight: '500', flex: 1 },
  parentPreview: { color: '#999', fontSize: 12, lineHeight: 16 },
});
