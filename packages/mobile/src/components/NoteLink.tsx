/**
 * NoteLink — tappable note reference that shows a preview card.
 *
 * Fetches the referenced event by ID (note1, nevent1, naddr1) and
 * renders a compact card with author info and truncated content.
 *
 * Mobile equivalent of packages/web/src/components/NoteLink.tsx.
 */
import { useState, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthor } from '../hooks/useAuthor';
import { useNostr } from '../lib/NostrProvider';
import { NoteContent } from './NoteContent';
import { SizeGuardedImage } from './SizeGuardedImage';
import { genUserName } from '@core/genUserName';
import { visibleLength, findVisibleCutoff } from '@core/textTruncation';

function getEventIdFromIdentifier(identifier: string): {
  id?: string;
  kind?: number;
  pubkey?: string;
  identifier?: string;
  relays?: string[];
} {
  try {
    const decoded = nip19.decode(identifier);
    if (decoded.type === 'note') {
      return { id: decoded.data };
    }
    if (decoded.type === 'nevent') {
      return {
        id: decoded.data.id,
        kind: decoded.data.kind,
        relays: decoded.data.relays,
        pubkey: decoded.data.author,
      };
    }
    if (decoded.type === 'naddr') {
      return {
        kind: decoded.data.kind,
        pubkey: decoded.data.pubkey,
        identifier: decoded.data.identifier,
        relays: decoded.data.relays,
      };
    }
  } catch {
    // Fall through
  }
  return {};
}

// ─── Inline content ──────────────────────────────────────────────────────────

function InlineNoteLinkContent({
  event,
  onViewThread,
}: {
  event: NostrEvent;
  onViewThread?: (eventId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: author } = useAuthor(event.pubkey);
  const displayName = author?.metadata?.display_name || author?.metadata?.name || genUserName(event.pubkey);
  const avatar = author?.metadata?.picture;

  const visLen = useMemo(() => visibleLength(event.content), [event.content]);
  const isLongContent = visLen > 125;

  const truncatedEvent = useMemo(() => {
    if (isExpanded || visLen <= 125) return event;
    return {
      ...event,
      content: event.content.slice(0, findVisibleCutoff(event.content, 125)).trimEnd() + '...',
    };
  }, [event, isExpanded, visLen]);

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onViewThread?.(event.id)}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        {avatar ? (
          <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Text style={styles.avatarLetter}>{displayName.slice(0, 2).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.headerInfo}>
          <Text style={styles.authorName} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.date}>
            {new Date(event.created_at * 1000).toLocaleDateString()}
          </Text>
        </View>
      </View>

      <NoteContent event={isExpanded ? event : truncatedEvent} numberOfLines={isExpanded ? undefined : 4} />

      {isLongContent && (
        <TouchableOpacity onPress={() => setIsExpanded(!isExpanded)}>
          <Text style={styles.expandText}>{isExpanded ? 'Show less' : 'Show more'}</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function NoteLinkSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={[styles.avatar, styles.skeletonCircle]} />
        <View style={styles.headerInfo}>
          <View style={[styles.skeletonLine, { width: 100 }]} />
          <View style={[styles.skeletonLine, { width: 60, height: 10 }]} />
        </View>
      </View>
      <View style={[styles.skeletonLine, { width: '100%', marginTop: 8 }]} />
      <View style={[styles.skeletonLine, { width: '75%', marginTop: 4 }]} />
    </View>
  );
}

// ─── Not found ───────────────────────────────────────────────────────────────

function NoteLinkNotFound({ onRetry, isFetching }: { onRetry?: () => void; isFetching?: boolean }) {
  return (
    <View style={styles.notFoundCard}>
      <Text style={styles.notFoundText}>
        {isFetching ? 'Retrying...' : 'Referenced note not found'}
      </Text>
      {onRetry && (
        <TouchableOpacity onPress={onRetry}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

interface NoteLinkProps {
  noteId: string;
  onViewThread?: (eventId: string) => void;
}

export function NoteLink({ noteId, onViewThread }: NoteLinkProps) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventInfo = getEventIdFromIdentifier(noteId);

  const { data: event, isLoading, isFetching } = useQuery({
    queryKey: ['note', noteId],
    queryFn: async () => {
      if (eventInfo.id) {
        const [ev] = await nostr.query(
          [{ ids: [eventInfo.id], limit: 1 }],
          { signal: AbortSignal.timeout(8000) },
        );
        return ev ?? null;
      }
      if (eventInfo.kind && eventInfo.pubkey && eventInfo.identifier) {
        const [ev] = await nostr.query(
          [{
            kinds: [eventInfo.kind],
            authors: [eventInfo.pubkey],
            '#d': [eventInfo.identifier],
            limit: 1,
          }],
          { signal: AbortSignal.timeout(8000) },
        );
        return ev ?? null;
      }
      return null;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    retryDelay: 4000,
  });

  if (isLoading) {
    return <NoteLinkSkeleton />;
  }

  if (!event) {
    return (
      <NoteLinkNotFound
        onRetry={() => queryClient.invalidateQueries({ queryKey: ['note', noteId] })}
        isFetching={isFetching}
      />
    );
  }

  return <InlineNoteLinkContent event={event} onViewThread={onViewThread} />;
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1f1f1f',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  avatar: { width: 28, height: 28, borderRadius: 14 },
  avatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#a855f7', fontSize: 10, fontWeight: '600' },
  headerInfo: { flex: 1 },
  authorName: { fontSize: 13, fontWeight: '600', color: '#f2f2f2' },
  date: { fontSize: 11, color: '#999' },
  expandText: {
    color: '#a855f7',
    fontSize: 12,
    marginTop: 4,
  },
  // Skeleton
  skeletonCircle: { backgroundColor: '#333' },
  skeletonLine: {
    height: 12,
    backgroundColor: '#333',
    borderRadius: 4,
    marginTop: 2,
  },
  // Not found
  notFoundCard: {
    backgroundColor: '#1f1f1f',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#404040',
    borderStyle: 'dashed',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  notFoundText: { color: '#666', fontSize: 13 },
  retryText: { color: '#a855f7', fontSize: 12 },
});
