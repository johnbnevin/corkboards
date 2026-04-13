/**
 * ProfileAbout — Renders the "about" field with proper text wrapping,
 * link detection, and nostr identifier parsing.
 * Mirrors web's ProfileAbout.tsx.
 */
import { useMemo } from 'react';
import { Text, StyleSheet, Linking, TouchableOpacity } from 'react-native';
import { nip19 } from 'nostr-tools';
import { hasHtmlContent } from '@core/sanitizeUtils';
import { NOSTR_IDENTIFIER_PATTERN } from '@core/nostr';

interface ProfileAboutProps {
  about?: string;
  pubkey?: string;
  style?: object;
}

export function ProfileAbout({ about, style }: ProfileAboutProps) {
  const elements = useMemo(() => {
    if (!about) return null;

    // Strip HTML tags if present
    const text = hasHtmlContent(about) ? about.replace(/<[^>]*>/g, '') : about;
    if (!text.trim()) return null;

    // Parse Nostr identifiers and hashtags.
    // Fresh regex per call -- /g flag is stateful.
    const regex = new RegExp(
      NOSTR_IDENTIFIER_PATTERN + '|(?<![#\\w])#([a-zA-Z]\\w{0,49})',
      'g',
    );

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let keyCounter = 0;

    while ((match = regex.exec(text)) !== null) {
      const [fullMatch, nostrPrefix1, nostrData1, nostrPrefix2, nostrData2, hashtagName] = match;
      const index = match.index;

      // Text before this match
      if (index > lastIndex) {
        parts.push(
          <Text key={`t-${keyCounter++}`} style={styles.text}>
            {text.substring(lastIndex, index)}
          </Text>,
        );
      }

      if (nostrPrefix1 && nostrData1) {
        // nostr: prefixed identifier
        try {
          const nostrId = `${nostrPrefix1}${nostrData1}`;
          nip19.decode(nostrId);
          parts.push(
            <Text key={`n-${keyCounter++}`} style={styles.nostrLink}>
              {fullMatch}
            </Text>,
          );
        } catch {
          parts.push(
            <Text key={`n-${keyCounter++}`} style={styles.text}>
              {fullMatch}
            </Text>,
          );
        }
      } else if (nostrPrefix2 && nostrData2) {
        // Non-prefixed identifier
        try {
          const nostrId = `${nostrPrefix2}${nostrData2}`;
          nip19.decode(nostrId);
          parts.push(
            <Text key={`n-${keyCounter++}`} style={styles.nostrLink}>
              {fullMatch}
            </Text>,
          );
        } catch {
          parts.push(
            <Text key={`n-${keyCounter++}`} style={styles.text}>
              {fullMatch}
            </Text>,
          );
        }
      } else if (hashtagName) {
        parts.push(
          <Text key={`h-${keyCounter++}`} style={styles.hashtag}>
            #{hashtagName}
          </Text>,
        );
      }

      lastIndex = index + fullMatch.length;
    }

    // Remaining text
    if (lastIndex < text.length) {
      parts.push(
        <Text key={`t-${keyCounter++}`} style={styles.text}>
          {text.substring(lastIndex)}
        </Text>,
      );
    }

    return parts.length > 0 ? parts : <Text style={styles.text}>{text}</Text>;
  }, [about]);

  if (!elements) return null;

  return (
    <Text style={[styles.container, style]}>
      {elements}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    fontSize: 14,
    color: '#b3b3b3',
    lineHeight: 20,
  },
  text: {
    color: '#b3b3b3',
  },
  nostrLink: {
    color: '#a855f7',
    fontWeight: '500',
  },
  hashtag: {
    color: '#a855f7',
  },
});
