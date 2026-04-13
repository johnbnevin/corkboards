/**
 * SmartNoteContent — wraps NoteContent with smart detection.
 *
 * - For JSON-embedded events: recursively renders the embedded event
 * - For HTML content: strips tags before rendering
 * - For long posts: shows a collapsible spoiler
 * - Handles video events (kind 34235) and long-form content (kind 30023)
 *
 * Mobile equivalent of packages/web/src/components/SmartNoteContent.tsx.
 */
import { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { visibleLength } from '@core/textTruncation';
import { hasHtmlContent } from '@core/sanitizeUtils';
import { NoteContent } from './NoteContent';

const SPOILER_THRESHOLD = 750;
const MAX_EMBED_DEPTH = 3;

/**
 * Try to parse JSON content that looks like an embedded Nostr event.
 * Some clients embed quoted posts as JSON in the content field.
 */
function tryParseEmbeddedEvent(content: string): NostrEvent | null {
  if (!content.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content);
    if (
      typeof parsed.id === 'string' && parsed.id.length === 64 &&
      typeof parsed.pubkey === 'string' && parsed.pubkey.length === 64 &&
      typeof parsed.content === 'string' &&
      typeof parsed.created_at === 'number' &&
      typeof parsed.kind === 'number' &&
      Array.isArray(parsed.tags) &&
      typeof parsed.sig === 'string'
    ) {
      return parsed as NostrEvent;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

interface SmartNoteContentProps {
  event: NostrEvent;
  /** When true, skip the long-post spoiler (media filter active) */
  forceExpand?: boolean;
  /** Internal: tracks recursive embed depth to prevent stack overflow */
  _embedDepth?: number;
  numberOfLines?: number;
}

export function SmartNoteContent({
  event,
  forceExpand = false,
  _embedDepth = 0,
  numberOfLines,
}: SmartNoteContentProps) {
  const [expanded, setExpanded] = useState(false);

  const text = event.content;
  const visLen = useMemo(() => visibleLength(text), [text]);
  const isLong = visLen > SPOILER_THRESHOLD * 1.5;

  // Check for JSON-embedded Nostr event
  const embeddedEvent = _embedDepth < MAX_EMBED_DEPTH ? tryParseEmbeddedEvent(text) : null;
  if (embeddedEvent) {
    return (
      <SmartNoteContent
        event={embeddedEvent}
        forceExpand={forceExpand}
        _embedDepth={_embedDepth + 1}
      />
    );
  }

  // Video kinds have content in imeta tags
  const isVideoKind = event.kind === 34235 || event.kind === 34236;
  const hasMedia = isVideoKind || /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)/i.test(text)
    || /https?:\/\/[^\s]*(nostr\.build|blossom\.|cdn\.sovbit|files\.primal|cdn\.satellite|void\.cat|media\.nostr\.band)/i.test(text);
  const hasNostrRefs = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+/.test(text);

  // If no visible text, no media, and no nostr references, show debug info
  if (visLen === 0 && !hasMedia && !hasNostrRefs && !text.startsWith('{')) {
    return (
      <View>
        <Text style={styles.debugText}>
          kind {event.kind} · {event.id.slice(0, 12)}...
        </Text>
        {text.length > 0 && (
          <Text style={styles.debugContent} numberOfLines={3}>
            {text.slice(0, 200)}
          </Text>
        )}
      </View>
    );
  }

  // Strip HTML if present
  const safeEvent = useMemo(() => {
    if (hasHtmlContent(text)) {
      return { ...event, content: text.replace(/<[^>]*>/g, '') };
    }
    return event;
  }, [event, text]);

  const content = (
    <NoteContent event={safeEvent} numberOfLines={numberOfLines} />
  );

  // Wrap long posts in a spoiler (skip when forceExpand is on)
  if (isLong && !expanded && !forceExpand) {
    return (
      <View>
        <View style={styles.spoilerContainer}>
          {content}
        </View>
        <View style={styles.gradientOverlay} />
        <TouchableOpacity
          onPress={() => setExpanded(true)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>Show more</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isLong && expanded) {
    return (
      <View>
        {content}
        <TouchableOpacity
          onPress={() => setExpanded(false)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>Show less</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return content;
}

const styles = StyleSheet.create({
  debugText: {
    fontSize: 11,
    color: '#666',
    fontFamily: 'monospace',
  },
  debugContent: {
    fontSize: 11,
    color: '#555',
    marginTop: 4,
  },
  spoilerContainer: {
    maxHeight: 200,
    overflow: 'hidden',
  },
  gradientOverlay: {
    height: 40,
    marginTop: -40,
    backgroundColor: 'rgba(42, 42, 42, 0.9)',
  },
  showMoreButton: {
    paddingVertical: 4,
  },
  showMoreText: {
    color: '#a855f7',
    fontSize: 12,
    fontWeight: '500',
  },
});
