import { useState } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { visibleLength } from '@core/textTruncation';
import { hasHtmlContent, sanitizeHtml } from '@/lib/sanitize';
import { NoteContent } from './NoteContent';

const SPOILER_THRESHOLD = 750;

interface SmartNoteContentProps {
  event: NostrEvent;
  className?: string;
  /** When true, embedded note links expand in-place instead of navigating (for use in modals) */
  inModalContext?: boolean;
  /** Callback for when user wants to view full thread (only used when inModalContext is true) */
  onViewThread?: (eventId: string) => void;
  /** When true, media is blurred until clicked (saves memory for off-screen notes) */
  blurMedia?: boolean;
  /** When true, skip the long-post spoiler (media filter active) */
  forceExpand?: boolean;
  /** Internal: tracks recursive embed depth to prevent stack overflow */
  _embedDepth?: number;
}

/**
 * Try to parse JSON content that looks like an embedded Nostr event.
 * Some clients embed quoted posts as JSON in the content field.
 */
function tryParseEmbeddedEvent(content: string): NostrEvent | null {
  if (!content.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content);
    // Validate all required Nostr event fields
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

/**
 * Enhanced note content component with smart rendering.
 * - For JSON-embedded events: recursively renders the embedded event
 * - For HTML content from the logged-in user: renders sanitized HTML
 * - For HTML content from others: shows a warning
 * - For all other content: delegates to NoteContent for rich rendering
 */
const MAX_EMBED_DEPTH = 3;

export function SmartNoteContent({ event, className, inModalContext = false, onViewThread, blurMedia = false, forceExpand = false, _embedDepth = 0 }: SmartNoteContentProps) {
  const [expanded, setExpanded] = useState(false);

  const text = event.content;
  const visLen = visibleLength(text);
  const isLong = visLen > SPOILER_THRESHOLD * 1.5;
  // ^ only trigger spoiler if well past threshold (avoid collapsing for just a few extra chars)
  // but when we do spoiler, truncate at the original threshold height

  // Check for JSON-embedded Nostr event (some clients embed quotes this way)
  const embeddedEvent = _embedDepth < MAX_EMBED_DEPTH ? tryParseEmbeddedEvent(text) : null;
  if (embeddedEvent) {
    // Recursively render the embedded event's content
    return (
      <SmartNoteContent
        event={embeddedEvent}
        className={className}
        inModalContext={inModalContext}
        onViewThread={onViewThread}
        blurMedia={blurMedia}
        forceExpand={forceExpand}
        _embedDepth={_embedDepth + 1}
      />
    );
  }

  // Video kinds have content in imeta tags, not necessarily in the content field
  const isVideoKind = event.kind === 34235 || event.kind === 34236;
  const hasMedia = isVideoKind || /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)/i.test(text)
    || /https?:\/\/[^\s]*(nostr\.build|blossom\.|cdn\.sovbit|files\.primal|cdn\.satellite|void\.cat|media\.nostr\.band)/i.test(text);
  const hasNostrRefs = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+/.test(text);

  // If no visible text, no media, and no nostr references, show debug info for unsupported/empty content
  if (visLen === 0 && !hasMedia && !hasNostrRefs && !text.startsWith('{')) {
    return (
      <div className={className}>
        <span className="text-xs text-muted-foreground font-mono">
          kind {event.kind} · {event.id.slice(0, 12)}…
          {text.length > 0 && <span className="block mt-1 break-all opacity-60">{text.slice(0, 200)}</span>}
        </span>
      </div>
    );
  }

  // Strip HTML if present — use DOMPurify (not regex) for reliable sanitisation, then
  // render as plain text/markdown. DOMPurify with ALLOWED_TAGS=[] strips all tags safely,
  // handling malformed HTML that simple regex misses.
  const hasHtml = hasHtmlContent(text);
  const safeEvent = hasHtml ? { ...event, content: sanitizeHtml(text).replace(/<[^>]*>/g, '') } : event;

  const content = (
    <NoteContent
      event={safeEvent}
      className={className}
      inModalContext={inModalContext}
      onViewThread={onViewThread}
      blurMedia={blurMedia}
    />
  );

  // Wrap long posts in a spoiler (skip when forceExpand is on, e.g. media filter active)
  if (isLong && !expanded && !forceExpand) {
    return (
      <div className="relative">
        <div className="max-h-48 overflow-hidden">
          {content}
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-card to-transparent" />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="relative z-10 w-full text-xs text-muted-foreground hover:text-foreground py-1 font-medium"
        >
          Show more
        </button>
      </div>
    );
  }

  if (isLong && expanded) {
    return (
      <div>
        {content}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-1 font-medium"
        >
          Show less
        </button>
      </div>
    );
  }

  return <>{content}</>;
}
