/**
 * ProfileAbout — Renders the "about" field with proper text wrapping,
 * link detection, and nostr identifier parsing.
 * Mirrors web's ProfileAbout.tsx.
 */
import { useMemo } from 'react';
import { Text, StyleSheet } from 'react-native';
import { nip19 } from 'nostr-tools';
import { hasHtmlContent } from '@core/sanitizeUtils';
import { sanitizeHtml } from '../lib/sanitize';
import { NIP19_IDENTIFIER_PATTERN } from '@core/nostr';

/** Lightweight nip-19 validity check — keeps JSX construction out of try/catch. */
function isValidNip19(id: string): boolean {
  try { nip19.decode(id); return true; } catch { return false; }
}

interface ProfileAboutProps {
  about?: string;
  pubkey?: string;
  style?: object;
}

export function ProfileAbout({ about, style }: ProfileAboutProps) {
  const elements = useMemo(() => {
    if (!about) return null;

    // Strip HTML tags if present — parity with web's ProfileAbout, which runs
    // the same shared sanitizer rather than a bare `/<[^>]*>/`.
    const text = hasHtmlContent(about) ? sanitizeHtml(about) : about;
    if (!text.trim()) return null;

    // Parse Nostr identifiers and hashtags.
    // Fresh regex per call -- /g flag is stateful.
    const regex = new RegExp(
      NIP19_IDENTIFIER_PATTERN + '|(?<![#\\w])#([a-zA-Z]\\w{0,49})',
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
        // nostr: prefixed identifier — validity-check outside JSX construction
        // so the eslint react-hooks/error-boundaries rule doesn't flag this.
        const valid = isValidNip19(`${nostrPrefix1}${nostrData1}`);
        parts.push(
          <Text key={`n-${keyCounter++}`} style={valid ? styles.nostrLink : styles.text}>
            {fullMatch}
          </Text>,
        );
      } else if (nostrPrefix2 && nostrData2) {
        const valid = isValidNip19(`${nostrPrefix2}${nostrData2}`);
        parts.push(
          <Text key={`n-${keyCounter++}`} style={valid ? styles.nostrLink : styles.text}>
            {fullMatch}
          </Text>,
        );
      } else if (hashtagName) {
        parts.push(
          <Text key={`h-${keyCounter++}`} style={styles.hashtag}>
            #{hashtagName}
          </Text>,
        );
      }

      lastIndex = index + fullMatch.length;
    }

    // Remaining text — final segment, post-increment of keyCounter would be a no-op
    if (lastIndex < text.length) {
      parts.push(
        <Text key={`t-${keyCounter}`} style={styles.text}>
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
