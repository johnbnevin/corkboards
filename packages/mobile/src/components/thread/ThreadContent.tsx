/**
 * ThreadContent — Smart content wrapper for thread notes.
 *
 * Uses NoteContent to render thread note content with optional line clamping.
 * Port of packages/web/src/components/thread/ThreadContent.tsx for React Native.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { NoteContent } from '../NoteContent';

const COLLAPSE_THRESHOLD = 280;

interface ThreadContentProps {
  event: NostrEvent;
  isTarget?: boolean;
}

export function ThreadContent({ event, isTarget }: ThreadContentProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = event.content.length > COLLAPSE_THRESHOLD;

  return (
    <View style={styles.container}>
      <NoteContent
        event={event}
        numberOfLines={!expanded && isLong ? 4 : (isTarget ? undefined : 8)}
      />
      {isLong && (
        <TouchableOpacity onPress={() => setExpanded(v => !v)}>
          <Text style={styles.toggle}>
            {expanded ? 'Show less' : 'Show more'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 4 },
  toggle: {
    color: '#f97316',
    fontSize: 12,
    marginTop: 2,
  },
});
