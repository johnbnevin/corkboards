/**
 * EmojiName -- Renders a display name with NIP-30 custom emoji support.
 * Replaces :shortcode: patterns with <Image> tags using emoji tags from the event.
 *
 * Port of packages/web/src/components/EmojiName.tsx for React Native.
 */
import { useMemo } from 'react';
import { Text, Image, StyleSheet } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';

interface EmojiNameProps {
  /** The display name text (may contain :shortcode: patterns) */
  name: string;
  /** The kind 0 profile event (or any event with emoji tags) */
  event?: NostrEvent;
  style?: object;
}

export function EmojiName({ name, event, style }: EmojiNameProps) {
  const parts = useMemo(() => {
    if (!event || !name) return null;

    // Build emoji map from event tags
    const emojiMap = new Map<string, string>();
    for (const tag of event.tags) {
      if (tag[0] === 'emoji' && tag[1] && tag[2]) {
        emojiMap.set(tag[1], tag[2]);
      }
    }
    if (emojiMap.size === 0) return null;

    // Split on :shortcode: patterns
    const segments = name.split(/:([a-zA-Z0-9_-]+):/g);
    if (segments.length <= 1) return null;

    const result: { type: 'text' | 'emoji'; value: string; url?: string }[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (i % 2 === 0) {
        if (segments[i]) result.push({ type: 'text', value: segments[i] });
      } else {
        const url = emojiMap.get(segments[i]);
        if (url) {
          result.push({ type: 'emoji', value: segments[i], url });
        } else {
          result.push({ type: 'text', value: `:${segments[i]}:` });
        }
      }
    }

    // Only return parts if at least one emoji was resolved
    if (!result.some(p => p.type === 'emoji')) return null;
    return result;
  }, [name, event]);

  if (!parts) {
    return <Text style={style}>{name}</Text>;
  }

  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.type === 'emoji' ? (
          <Image
            key={i}
            source={{ uri: p.url }}
            style={styles.emojiImage}
            resizeMode="contain"
          />
        ) : (
          <Text key={i}>{p.value}</Text>
        )
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  emojiImage: {
    width: 18,
    height: 18,
  },
});
