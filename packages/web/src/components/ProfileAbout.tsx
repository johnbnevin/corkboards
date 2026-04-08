import { useMemo } from 'react';
import { hasHtmlContent } from '@/lib/sanitize';
import { Link } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import { NOSTR_IDENTIFIER_PATTERN } from '@core/nostr';

interface ProfileAboutProps {
  about?: string;
  pubkey?: string; // kept for API compat but unused
  className?: string;
}

/**
 * Component for safely rendering profile about fields.
 * Strips all HTML tags and renders as plain text with Nostr identifiers and hashtags linked.
 */
export function ProfileAbout({ about, className }: ProfileAboutProps) {
  const content = useMemo(() => {
    if (!about) return { type: 'empty' as const };

    // Strip HTML tags if present — always render as plain text
    const text = hasHtmlContent(about) ? about.replace(/<[^>]*>/g, '') : about;
    if (!text.trim()) return { type: 'empty' as const };

    // Parse Nostr identifiers and hashtags.
    // Nostr pattern from @core/nostr; hashtag extension added here only.
    // Hashtags must start with a letter (not digit) and not be preceded by # (avoids markdown headers like ###).
    // Fresh regex per call — /g flag is stateful, never reuse a module-level instance.
    // Hashtags must start with a letter (not digit) and not be preceded by # (avoids markdown headers like ###).
    const regex = new RegExp(NOSTR_IDENTIFIER_PATTERN + '|(?<![#\\w])#([a-zA-Z]\\w{0,49})', 'g');

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let keyCounter = 0;

    while ((match = regex.exec(text)) !== null) {
      const [fullMatch, nostrPrefix1, nostrData1, nostrPrefix2, nostrData2, hashtagName] = match;
      const index = match.index;

      // Add text before this match
      if (index > lastIndex) {
        parts.push(text.substring(lastIndex, index));
      }

      if (nostrPrefix1 && nostrData1) {
        // nostr: prefixed
        try {
          const nostrId = `${nostrPrefix1}${nostrData1}`;
          nip19.decode(nostrId); // Validate the identifier
          parts.push(
            <Link
              key={`nostr-${keyCounter++}`}
              to={`/${nostrId}`}
              className="text-purple-500 hover:underline font-medium"
            >
              {fullMatch}
            </Link>
          );
        } catch {
          parts.push(fullMatch);
        }
      } else if (nostrPrefix2 && nostrData2) {
        // non-prefixed
        try {
          const nostrId = `${nostrPrefix2}${nostrData2}`;
          nip19.decode(nostrId); // Validate the identifier
          parts.push(
            <Link
              key={`nostr-${keyCounter++}`}
              to={`/${nostrId}`}
              className="text-purple-500 hover:underline font-medium"
            >
              {fullMatch}
            </Link>
          );
        } catch {
          parts.push(fullMatch);
        }
      } else if (hashtagName) {
        // hashtag - hashtagName is just the tag without #, fullMatch includes the #
        parts.push(
          <Link
            key={`tag-${keyCounter++}`}
            to={`/t/${hashtagName}`}
            className="text-purple-500 hover:underline"
          >
            #{hashtagName}
          </Link>
        );
      }

      lastIndex = index + fullMatch.length;
    }

    // Add any remaining text
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return {
      type: 'text' as const,
      elements: parts.length > 0 ? parts : text
    };
  }, [about]);

  if (content.type === 'empty') {
    return null;
  }

  return (
    <p className={className || "text-gray-600 dark:text-gray-300 mt-1"}>
      {content.elements}
    </p>
  );
}
