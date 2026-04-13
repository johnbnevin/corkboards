import { nip19 } from 'nostr-tools';
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { NOSTR_IDENTIFIER_PATTERN } from '@core/nostr';

// Decoded identifier types that onPress handlers receive
export type NostrIdentifierData =
  | { type: 'npub'; pubkey: string; raw: string }
  | { type: 'nprofile'; pubkey: string; relays?: string[]; raw: string }
  | { type: 'note'; id: string; raw: string }
  | { type: 'nevent'; id: string; relays?: string[]; author?: string; raw: string }
  | { type: 'naddr'; identifier: string; pubkey: string; kind: number; relays?: string[]; raw: string };

/**
 * Parses Nostr identifiers (npub1, nprofile1, note1, nevent1, naddr1) in text
 * and returns React Native elements with tappable links.
 *
 * @param text - The text to parse
 * @param onPress - Callback invoked when a parsed identifier is tapped
 * @returns Array of React nodes with parsed identifiers
 */
export function parseNostrIdentifiers(
  text: string,
  onPress?: (data: NostrIdentifierData) => void,
): React.ReactNode[] {
  // Fresh regex per call — /g flag is stateful, never reuse a module-level instance
  const regex = new RegExp(NOSTR_IDENTIFIER_PATTERN, 'g');

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyCounter = 0;

  while ((match = regex.exec(text)) !== null) {
    const [fullMatch, nostrPrefix1, nostrData1, nostrPrefix2, nostrData2] = match;
    const index = match.index;

    // Add text before this match
    if (index > lastIndex) {
      parts.push(text.substring(lastIndex, index));
    }

    const nostrPrefix = nostrPrefix1 || nostrPrefix2;
    const nostrData = nostrData1 || nostrData2;

    if (nostrPrefix && nostrData) {
      try {
        const nostrId = `${nostrPrefix}${nostrData}`;
        const decoded = nip19.decode(nostrId);

        const key = `nostr-${keyCounter++}`;

        // Build the decoded data for the onPress callback
        let identifierData: NostrIdentifierData;

        if (decoded.type === 'npub') {
          identifierData = { type: 'npub', pubkey: decoded.data as string, raw: nostrId };
        } else if (decoded.type === 'nprofile') {
          const d = decoded.data as { pubkey: string; relays?: string[] };
          identifierData = { type: 'nprofile', pubkey: d.pubkey, relays: d.relays, raw: nostrId };
        } else if (decoded.type === 'note') {
          identifierData = { type: 'note', id: decoded.data as string, raw: nostrId };
        } else if (decoded.type === 'nevent') {
          const d = decoded.data as { id: string; relays?: string[]; author?: string };
          identifierData = { type: 'nevent', id: d.id, relays: d.relays, author: d.author, raw: nostrId };
        } else if (decoded.type === 'naddr') {
          const d = decoded.data as { identifier: string; pubkey: string; kind: number; relays?: string[] };
          identifierData = { type: 'naddr', identifier: d.identifier, pubkey: d.pubkey, kind: d.kind, relays: d.relays, raw: nostrId };
        } else {
          // Unknown type — render as plain text
          parts.push(fullMatch);
          lastIndex = index + fullMatch.length;
          continue;
        }

        // Display label
        const label =
          decoded.type === 'npub' || decoded.type === 'nprofile'
            ? `@${nostrId.slice(0, 12)}...`
            : fullMatch;

        parts.push(
          <Text
            key={key}
            style={styles.nostrLink}
            onPress={onPress ? () => onPress(identifierData) : undefined}
          >
            {label}
          </Text>,
        );
      } catch {
        // If decoding fails, just render as plain text
        parts.push(fullMatch);
      }
    }

    lastIndex = index + fullMatch.length;
  }

  // Add any remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

/**
 * Extracts nevent identifiers from text content.
 * Returns array of nevent IDs.
 */
export function extractNevents(text: string): string[] {
  // Uses Bech32 charset: qpzry9x8gf2tvdw0s3jn54khce6mua7l
  const regex = /nostr:nevent1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)|nevent1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)/gi;
  const neventIds: string[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const data = match[1] || match[2];
    const fullId = `nevent1${data}`;
    if (!neventIds.includes(fullId)) {
      neventIds.push(fullId);
    }
  }

  return neventIds;
}

/**
 * Checks if text contains any Nostr identifiers.
 * Uses a non-/g regex (no statefulness concern) for a simple boolean test.
 */
export function hasNostrIdentifiers(text: string): boolean {
  return new RegExp(NOSTR_IDENTIFIER_PATTERN, 'i').test(text);
}

const styles = StyleSheet.create({
  nostrLink: {
    color: '#a855f7',
    fontWeight: '500',
  },
});
