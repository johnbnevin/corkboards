/**
 * NoteCard — card wrapper for a single note in the feed.
 *
 * Shows author avatar, display name, time, content (via NoteContent),
 * and action buttons (via NoteActions). Handles reposts with a header banner.
 * Mobile equivalent of packages/web/src/components/NoteCard.tsx.
 */
import { memo, useMemo, useState } from 'react';
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
import { useIsDeletedAuthor } from '../contexts/deletedAuthors';
import { visibleLength, findVisibleCutoff } from '@core/textTruncation';
import { verifyEmbeddedEvent } from '../lib/embeddedEvent';
import { useNoteCollapsedState, useCollapsedNotesActions } from '../hooks/useCollapsedNotes';

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
  /**
   * Takes the note id rather than being a pre-bound thunk. Screens used to pass
   * `() => toggleBookmark(item.id)`, a fresh closure on every render of every
   * row — which made `memo` on this component useless, since one prop always
   * differed by identity. Passing the stable `toggleBookmark` itself and binding
   * the id here keeps the shallow compare meaningful.
   */
  onToggleBookmark?: (id: string) => void;
  onViewProfile?: (pubkey: string) => void;
  onViewThread?: (eventId: string) => void;
  /** Parent note for replies (the note being replied to) */
  parentNote?: NostrEvent | null;
  /** Whether this note was recently added (for highlighting) */
  isFresh?: boolean;
  /** When true, a media filter is active — auto-expand and unblur media */
  mediaFilterActive?: boolean;
  /** True when this note carries the corkboard's hashtag as a `t` tag but never
   *  mentions it in its content — shown as a badge. */
  hashtagTaggedOnly?: boolean;
  /** The specific hashtag the note is tagged-but-not-mentioned for. */
  hashtagTaggedLabel?: string;
  /** Feed context: show the save-for-later (green) + dismiss (red) corner
   *  actions and honor the soft-dismissed / collapsed placeholders. Off in
   *  thread/saved views where those don't apply. */
  showCollapseActions?: boolean;
  /** Pinned-note ids (NIP-51 kind 10001), provided by the screen so the pin
   *  hook runs once per screen rather than once per card. When set, the card
   *  shows the pin affordance + pinned styling. */
  pinnedSet?: Set<string>;
  /** Toggle a note's pin state. Presence enables the action-bar pin button. */
  onTogglePin?: (id: string) => void;
}

function NoteCardImpl({
  event,
  onReply,
  isBookmarked = false,
  onToggleBookmark,
  onViewProfile,
  onViewThread,
  parentNote,
  isFresh = false,
  mediaFilterActive = false,
  hashtagTaggedOnly = false,
  hashtagTaggedLabel,
  showCollapseActions = false,
  pinnedSet,
  onTogglePin,
}: NoteCardProps) {
  const isRepost = event.kind === 6;
  const [expanded, setExpanded] = useState(false);

  // For reposts, parse the inner event — signature-verified before we attribute
  // it to the author it claims. NIP-18 puts attacker-controlled JSON in a kind-6
  // `content`; an unverified embed must never drive the avatar/name/profile link.
  // A forged/malformed embed falls back to the wrapper rather than impersonating.
  const displayEvent = useMemo(() => {
    if (!isRepost) return event;
    return verifyEmbeddedEvent(event.content) ?? event;
  }, [event, isRepost]);

  // Pinned state (NIP-51) is keyed on the displayed note — the inner note for a
  // repost — so pinning from a repost card pins the actual content.
  const pinned = !!pinnedSet?.has(displayEvent.id);

  const { data: repostAuthorData } = useAuthor(event.pubkey);
  const { data } = useAuthor(displayEvent.pubkey);
  // Author confirmed deleted/vanished (NIP-09 profile deletion / NIP-62 vanish).
  const isDeletedAuthor = useIsDeletedAuthor(displayEvent.pubkey);
  const displayName = isDeletedAuthor
    ? 'Deleted account'
    : (data?.metadata?.display_name || data?.metadata?.name || genUserName(displayEvent.pubkey));
  const repostName =
    repostAuthorData?.metadata?.display_name || repostAuthorData?.metadata?.name || genUserName(event.pubkey);
  const avatar = isDeletedAuthor ? undefined : data?.metadata?.picture;

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

  // Save-for-later / dismiss (feed only). The engine + feed dismiss-filter
  // already exist; this adds the on-card affordance, matching web and the
  // mobile NotificationCard. Keyed on the feed item (event.id), which is what
  // the feed filter checks.
  // Per-note subscription + stable actions, NOT the whole hook: reading the
  // hook here made every mounted card parse the persisted id lists out of MMKV
  // on mount and re-render on every dismissal anywhere in the feed.
  const noteState = useNoteCollapsedState(event.id);
  const { toggleCollapsed, dismiss, dismissThreadRoots, undoDismiss } = useCollapsedNotesActions();
  const softDismissed = showCollapseActions && noteState.isSoftDismissed;
  const collapsed = showCollapseActions && noteState.isCollapsed;
  // Long-pressing dismiss hides the whole thread: mark its NIP-10 root (or this
  // note when it is the root) as a dismissed thread root so members that arrive
  // later are filtered too, then dismiss this card.
  const threadRoot = event.tags.find(t => t[0] === 'e' && t[3] === 'root')?.[1]
    ?? event.tags.find(t => t[0] === 'e' && t[1])?.[1]
    ?? event.id;

  if (softDismissed) {
    const canUndo = noteState.canUndoDismiss;
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
  if (collapsed) {
    return (
      <TouchableOpacity style={styles.placeholder} onPress={() => toggleCollapsed(event.id)}>
        <Text style={styles.placeholderText}>saved for later</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.card, isFresh && styles.freshCard, pinned && styles.pinnedCard, isDeletedAuthor && styles.deletedCard]}
      onPress={() => onViewThread?.(displayEvent.id)}
      activeOpacity={0.8}
    >
      {showCollapseActions && (
        <View style={styles.cornerRow} pointerEvents="box-none">
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
            onLongPress={() => { dismissThreadRoots([threadRoot]); dismiss(event.id); }}
            delayLongPress={350}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={styles.redTriangle} />
          </TouchableOpacity>
        </View>
      )}
      {isDeletedAuthor && (
        <Text style={styles.deletedNotice}>⊘ This user deleted their account.</Text>
      )}
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

      {/* Pinned-to-board flag (NIP-51 kind 10001) */}
      {pinned && (
        <View style={styles.pinnedFlag}>
          <Text style={styles.pinnedFlagText}>📌 Pinned to your board</Text>
        </View>
      )}

      {/* Note content */}
      <NoteContent event={truncatedEvent} numberOfLines={isLong && !expanded && !mediaFilterActive ? 12 : undefined} />

      {/* Tagged-but-not-mentioned flag for hashtag corkboards */}
      {hashtagTaggedOnly && (
        <View style={styles.taggedFlag}>
          <Text style={styles.taggedFlagText}>
            #{hashtagTaggedLabel ?? 'tag'} · tagged, not mentioned
          </Text>
        </View>
      )}

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
        // `event.id`, not `displayEvent.id`: for a repost the bookmark has
        // always been keyed on the wrapper, and the screens read
        // `isBookmarked(item.id)` the same way. Keep the two in step.
        onToggleBookmark={onToggleBookmark ? () => onToggleBookmark(event.id) : undefined}
        isPinned={pinned}
        onTogglePin={onTogglePin ? () => onTogglePin(displayEvent.id) : undefined}
      />
    </TouchableOpacity>
  );
}

/**
 * Memoized: a feed is a long FlatList of these, and every card subscribes to
 * profile lookups, engagement counts and note parsing. Without memo, any state
 * change on the screen (a scroll flag, a new note arriving, the tab switching)
 * re-rendered every mounted card and re-ran all of that work. The callers pass
 * stable, `useCallback`-wrapped handlers, so the default shallow prop compare is
 * the correct one — it stays correct only for as long as they do.
 */
export const NoteCard = memo(NoteCardImpl);

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
  placeholderText: { color: '#666', fontSize: 11 },
  cornerRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  saveCorner: { width: 36, height: 36 },
  dismissCorner: { width: 36, height: 36, alignItems: 'flex-end' },
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
  taggedFlag: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: '#333',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  taggedFlagText: {
    color: '#999',
    fontSize: 10,
  },
  freshCard: {
    borderColor: '#a855f7',
    borderWidth: 1.5,
    backgroundColor: '#2c2540', // subtle purple tint, mirrors web's bg-purple-950/30
  },
  pinnedCard: {
    borderColor: '#f97316',
    borderWidth: 1.5,
  },
  pinnedFlag: {
    alignSelf: 'flex-start',
    marginBottom: 8,
    backgroundColor: '#3a2a1a',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pinnedFlagText: {
    color: '#f97316',
    fontSize: 10,
    fontWeight: '600',
  },
  deletedCard: {
    opacity: 0.7,
  },
  deletedNotice: {
    fontSize: 11,
    color: '#8a8a8a',
    marginBottom: 6,
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
