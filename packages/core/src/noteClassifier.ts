import { type NostrEvent } from '@nostrify/nostrify';

/** Returns true only for a well-formed 64-char lowercase hex event ID. */
function isValidEventId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
}

export interface NoteClassification {
  isReply: boolean;           // Has e-tag (replying to someone)
  isQuote: boolean;           // Has q-tag (quote repost)
  isOriginal: boolean;        // No e-tag or q-tag
  parentEventId?: string;     // Direct parent (for replies)
  rootEventId?: string;       // Thread root (for deep threads)
  quotedEventId?: string;     // Quoted event ID (for quotes)
}

/**
 * Classify a Nostr event as original, reply, or quote.
 * Uses NIP-10 conventions for e-tag parsing (root/reply markers).
 */
export function classifyNote(event: NostrEvent): NoteClassification {
  const eTags = event.tags.filter(t => t[0] === 'e');
  const qTags = event.tags.filter(t => t[0] === 'q');

  // Parse e-tags using NIP-10 conventions
  // Format: ['e', eventId, relayUrl?, marker?]
  // Markers: 'root', 'reply', 'mention'
  const rootTag = eTags.find(t => t[3] === 'root');
  const replyTag = eTags.find(t => t[3] === 'reply');

  // Get parent event ID (what this note is directly replying to)
  let parentEventId: string | undefined;
  let rootEventId: string | undefined;

  if (replyTag) {
    // Explicit reply marker
    const id = replyTag[1];
    if (isValidEventId(id)) parentEventId = id;
  } else if (eTags.length === 1) {
    // Single e-tag: it's both root and parent
    const id = eTags[0][1];
    if (isValidEventId(id)) parentEventId = id;
  } else if (eTags.length > 1) {
    // Multiple e-tags without markers: last one is parent (NIP-10 deprecated convention)
    const id = eTags[eTags.length - 1][1];
    if (isValidEventId(id)) parentEventId = id;
  }

  // Get root event ID
  if (rootTag) {
    const id = rootTag[1];
    if (isValidEventId(id)) rootEventId = id;
  } else if (eTags.length >= 1) {
    // First e-tag is typically the root
    const id = eTags[0][1];
    if (isValidEventId(id)) rootEventId = id;
  }

  // Get quoted event ID from q-tag
  // Format: ['q', eventId, relayUrl?, pubkey?]
  const rawQuoted = qTags[0]?.[1];
  const quotedEventId = isValidEventId(rawQuoted) ? rawQuoted : undefined;

  // Determine classification
  // Only e-tags without a marker or with "reply"/"root" markers indicate a reply.
  // e-tags with "mention" marker are inline references, not reply threading.
  const hasReplyETags = eTags.some(t => !t[3] || t[3] === 'reply' || t[3] === 'root');
  const hasQTags = qTags.length > 0;

  return {
    isReply: hasReplyETags && !hasQTags,
    isQuote: hasQTags,
    isOriginal: !hasReplyETags && !hasQTags,
    parentEventId: hasReplyETags ? parentEventId : undefined,
    rootEventId: hasReplyETags ? rootEventId : undefined,
    quotedEventId: hasQTags && quotedEventId ? quotedEventId : undefined,
  };
}

/**
 * Check if an event is a direct reply to a specific event ID.
 */
export function isDirectReplyTo(event: NostrEvent, targetEventId: string): boolean {
  const classification = classifyNote(event);
  return classification.isReply && classification.parentEventId === targetEventId;
}

/**
 * Check if an event is part of a thread (has any e-tags).
 */
export function isPartOfThread(event: NostrEvent): boolean {
  return event.tags.some(t => t[0] === 'e');
}

/**
 * Get all event IDs that this note references (parents, root, quoted).
 */
export function getReferencedEventIds(event: NostrEvent): string[] {
  const ids: string[] = [];

  for (const tag of event.tags) {
    if ((tag[0] === 'e' || tag[0] === 'q') && isValidEventId(tag[1])) {
      ids.push(tag[1]);
    }
  }

  return [...new Set(ids)]; // Deduplicate
}

/**
 * Build NIP-10 reply tags for a new reply to `replyTo`.
 *
 * Follows NIP-10 conventions:
 * - If `replyTo` has a root e-tag, that stays root and `replyTo.id` becomes the reply marker.
 * - If `replyTo` has no root e-tag (it's a top-level note), `replyTo.id` is both root.
 * - Always includes a p-tag for the author being replied to.
 *
 * Returns an array of string[][] tags ready to be included in a new event.
 */
export function buildReplyTags(replyTo: NostrEvent): string[][] {
  const tags: string[][] = [];
  const rootTag = replyTo.tags.find(t => t[0] === 'e' && t[3] === 'root');
  const rootId = rootTag?.[1] || replyTo.id;

  if (rootId !== replyTo.id) {
    tags.push(['e', rootId, '', 'root']);
  }
  tags.push(['e', replyTo.id, '', replyTo.id === rootId ? 'root' : 'reply']);
  tags.push(['p', replyTo.pubkey]);
  return tags;
}
