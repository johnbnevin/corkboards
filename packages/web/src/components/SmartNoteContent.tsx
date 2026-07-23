import { useState } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { visibleLength } from '@core/textTruncation';
import { hasHtmlContent, sanitizeHtml } from '@/lib/sanitize';
import { NoteContent } from './NoteContent';
import { ListingCard } from './ListingCard';
import { MediaLink } from './MediaLink';
import { BarChart3, Radio } from 'lucide-react';

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

  // NIP-94 file metadata (kind 1063) — the file lives in the `url` tag, not the
  // content field; content is an optional caption/description.
  if (event.kind === 1063) {
    const fileUrl = event.tags.find(t => t[0] === 'url')?.[1];
    const mime = event.tags.find(t => t[0] === 'm')?.[1] ?? '';
    if (fileUrl) {
      return (
        <div className={className}>
          <MediaLink url={fileUrl} blurMedia={blurMedia} isVideo={mime.startsWith('video/')} />
          {event.content && <NoteContent event={event} inModalContext={inModalContext} onViewThread={onViewThread} blurMedia={blurMedia} />}
        </div>
      );
    }
    // No url tag — fall through to generic rendering below.
  }

  // NIP-88 poll (kind 1068) — content is the question, options live in tags.
  if (event.kind === 1068) {
    const options = event.tags.filter(t => t[0] === 'option' && t[1] && t[2]);
    return (
      <div className={className}>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          <BarChart3 className="h-3.5 w-3.5" />
          <span>Poll</span>
        </div>
        {event.content && <NoteContent event={event} inModalContext={inModalContext} onViewThread={onViewThread} blurMedia={blurMedia} />}
        <ul className="mt-2 space-y-1">
          {options.map(([, id, label]) => (
            <li key={id} className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">{label}</li>
          ))}
        </ul>
      </div>
    );
  }

  // NIP-53 live event (kind 30311) — structured stream info lives in tags.
  if (event.kind === 30311) {
    const title = event.tags.find(t => t[0] === 'title')?.[1];
    const summary = event.tags.find(t => t[0] === 'summary')?.[1];
    const status = event.tags.find(t => t[0] === 'status')?.[1];
    const streaming = event.tags.find(t => t[0] === 'streaming')?.[1];
    const image = event.tags.find(t => t[0] === 'image')?.[1];
    return (
      <div className={className}>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          <Radio className={`h-3.5 w-3.5 ${status === 'live' ? 'text-red-500' : ''}`} />
          <span>{status === 'live' ? 'Live now' : status === 'ended' ? 'Stream ended' : 'Live event'}</span>
        </div>
        {title && <div className="font-semibold text-sm">{title}</div>}
        {summary && <div className="text-sm text-muted-foreground">{summary}</div>}
        {image && <MediaLink url={image} blurMedia={blurMedia} />}
        {streaming && status === 'live' && <MediaLink url={streaming} blurMedia={blurMedia} isVideo />}
      </div>
    );
  }

  // NIP-99 classified listing (kind 30402) — structured fields live in tags, so
  // render the dedicated card instead of treating the body as a plain note.
  if (event.kind === 30402) {
    return (
      <ListingCard
        event={event}
        className={className}
        inModalContext={inModalContext}
        onViewThread={onViewThread}
        blurMedia={blurMedia}
      />
    );
  }

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

  // Picture/video events keep their media in imeta (NIP-92) tags, not the
  // content field. Treat any event carrying imeta as having media so NoteContent
  // gets a chance to render it (kind 20 pictures, 21/22/34235/34236 video, etc.).
  const hasImeta = event.tags.some(t => t[0] === 'imeta');
  const hasMedia = hasImeta || /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)/i.test(text)
    || /https?:\/\/[^\s]*(nostr\.build|blossom\.|cdn\.sovbit|files\.primal|cdn\.satellite|void\.cat|media\.nostr\.band)/i.test(text);
  const hasNostrRefs = /(nostr:)?(note1|npub1|nprofile1|nevent1|naddr1)[a-zA-Z0-9]+/.test(text);

  // If no visible text, no media, and no nostr references, fall back to the
  // NIP-31 `alt` tag (a human-readable summary many clients attach to novel
  // kinds) so unknown events read as text instead of a raw "kind N" debug line.
  if (visLen === 0 && !hasMedia && !hasNostrRefs && !text.startsWith('{')) {
    const altTag = event.tags.find(t => t[0] === 'alt')?.[1];
    return (
      <div className={className}>
        {altTag
          ? <span className="text-sm text-muted-foreground">{altTag}</span>
          : <span className="text-xs text-muted-foreground font-mono">
              kind {event.kind} · {event.id.slice(0, 12)}…
              {text.length > 0 && <span className="block mt-1 break-all opacity-60">{text.slice(0, 200)}</span>}
            </span>}
      </div>
    );
  }

  // Strip HTML if present — sanitizeHtml uses DOMPurify with ALLOWED_TAGS=[] which
  // removes all tags safely (handling malformed HTML that a regex would miss) and
  // keeps only the text content, rendered as plain text/markdown.
  const hasHtml = hasHtmlContent(text);
  const safeEvent = hasHtml ? { ...event, content: sanitizeHtml(text) } : event;

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
