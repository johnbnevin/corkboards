import { nip19 } from 'nostr-tools';
import { Link } from 'react-router-dom';
import React from 'react';
import { NOSTR_IDENTIFIER_PATTERN } from '@core/nostr';

/**
 * Parses Nostr identifiers (npub1, nprofile1, note1, nevent1, naddr1) in text
 * and returns React elements with proper links.
 *
 * @param text - The text to parse
 * @returns Array of React nodes with parsed identifiers
 */
export function parseNostrIdentifiers(text: string): React.ReactNode[] {
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

        // Use consistent key generation
        const key = `nostr-${keyCounter++}`;

        if (decoded.type === 'npub' || decoded.type === 'nprofile') {
          // Return mention style for profiles
          parts.push(
            <Link
              key={key}
              to={`/${nostrId}`}
              className="text-purple-500 hover:underline font-medium"
            >
              @{nostrId.slice(0, 12)}...
            </Link>
          );
        } else if (decoded.type === 'nevent') {
          // Return link for events (could be made to embed)
          parts.push(
            <Link
              key={key}
              to={`/${nostrId}`}
              className="text-purple-500 hover:underline"
            >
              {fullMatch}
            </Link>
          );
        } else {
          // note1, naddr, etc.
          parts.push(
            <Link
              key={key}
              to={`/${nostrId}`}
              className="text-purple-500 hover:underline"
            >
              {fullMatch}
            </Link>
          );
        }
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
 * Extracts nevent identifiers from text content
 * Returns array of nevent IDs
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
