import { type NostrEvent } from '@nostrify/nostrify';

/** Returns true only for a well-formed 64-char lowercase hex event ID. */
export function isValidEventId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
}

/** Returns true only for a well-formed 64-char lowercase hex pubkey.
 *  Same shape as an event id; kept separate so call sites read correctly. */
export function isValidPubkey(pk: unknown): pk is string {
  return typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk);
}

/** Accept only a ws(s) relay URL as a hint — anything else is dropped rather
 *  than published, so a malformed hint can't propagate up a thread forever. */
export function isValidRelayHint(url: unknown): url is string {
  return typeof url === 'string' && /^wss?:\/\/[^\s]+$/i.test(url);
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
  // NIP-22 comment (kind 1111): lowercase e = direct parent, uppercase E = root.
  // Always a reply by definition.
  if (event.kind === 1111) {
    const parentId = event.tags.find(t => t[0] === 'e' && isValidEventId(t[1]))?.[1];
    const rootId = event.tags.find(t => t[0] === 'E' && isValidEventId(t[1]))?.[1];
    return {
      isReply: true,
      isQuote: false,
      isOriginal: false,
      parentEventId: parentId,
      rootEventId: rootId ?? parentId,
      quotedEventId: undefined,
    };
  }

  const eTags = event.tags.filter(t => t[0] === 'e');
  const qTags = event.tags.filter(t => t[0] === 'q');

  // Parse e-tags using NIP-10 conventions
  // Format: ['e', eventId, relayUrl?, marker?]
  // Markers: 'root', 'reply', 'mention'
  const rootTag = eTags.find(t => t[3] === 'root');
  const replyTag = eTags.find(t => t[3] === 'reply');
  // Deprecated positional e-tags are `[root, mention…, reply]`, so an e-tag the
  // author explicitly marked 'mention' is a citation, never a thread position.
  // Leaving mentions in the positional list is how a quoted note ended up being
  // treated as the parent — the note attaches under something it merely cited.
  const positional = eTags.filter(t => t[3] !== 'mention');

  // Get parent event ID (what this note is directly replying to)
  let parentEventId: string | undefined;
  let rootEventId: string | undefined;

  if (replyTag && replyTag.length > 1) {
    // Explicit reply marker
    const id = replyTag[1];
    if (isValidEventId(id)) parentEventId = id;
  } else if (rootTag && rootTag.length > 1) {
    // Marked scheme with a root but no reply: NIP-10 says a direct reply to the
    // root of a thread carries only the 'root' marker, so the root IS the parent.
    const id = rootTag[1];
    if (isValidEventId(id)) parentEventId = id;
  } else if (positional.length === 1 && positional[0].length > 1) {
    // Single e-tag: it's both root and parent
    const id = positional[0][1];
    if (isValidEventId(id)) parentEventId = id;
  } else if (positional.length > 1 && positional[positional.length - 1].length > 1) {
    // Multiple e-tags without markers: last one is parent (NIP-10 deprecated convention)
    const id = positional[positional.length - 1][1];
    if (isValidEventId(id)) parentEventId = id;
  }

  // Get root event ID
  if (rootTag && rootTag.length > 1) {
    const id = rootTag[1];
    if (isValidEventId(id)) rootEventId = id;
  } else if (positional.length >= 1 && positional[0].length > 1) {
    // First e-tag is typically the root
    const id = positional[0][1];
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
    quotedEventId: quotedEventId || undefined,
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
 * - p-tags carry the immediate parent's author PLUS the parent's own p-tags. Because every
 *   reply forwards its parent's p-tags, the parent already holds the full ancestor chain, so
 *   this yields parent → grandparent → … → root author (never siblings) while reading only the
 *   parent event we already hold. Matches NIP-10's example ([a1, p1, p2, p3]). Clients that
 *   build their notification feed from p-tags (most of them) therefore notify everyone in the
 *   ancestor chain, not just the person directly replied to.
 * - Relay hints: the reply (parent) e-tag uses the caller-supplied `replyRelayHint`; the root
 *   e-tag reuses the relay hint the parent already carried on its own root tag. p-tags carry
 *   hints too — the parent author gets `replyRelayHint` (it is that author's outbox relay,
 *   which is where the caller looked it up), and forwarded participants keep whatever hint the
 *   parent recorded for them. A hint that isn't a `ws(s)://` URL is dropped rather than
 *   forwarded, so junk can't propagate up a thread indefinitely.
 * - Every e-tag also carries NIP-10's optional 5th element, the referenced event's author
 *   pubkey, so a client that can't find the event can still resolve who to attribute it to.
 *   The root's author is only known when the parent forwarded it; otherwise it's omitted.
 *
 * @param replyTo - The event being replied to (the immediate parent).
 * @param replyRelayHint - Optional relay hint for locating the parent event.
 * Returns an array of string[][] tags ready to be included in a new event.
 */
export function buildReplyTags(replyTo: NostrEvent, replyRelayHint = ''): string[][] {
  const tags: string[][] = [];
  const hint = isValidRelayHint(replyRelayHint) ? replyRelayHint : '';
  const parentETags = replyTo.tags.filter(t => t[0] === 'e');
  // Marked scheme first; otherwise the DEPRECATED-POSITIONAL scheme, where the
  // parent's FIRST e-tag is the thread root (`[root, mention…, reply]`). Without
  // that fallback a reply to any note from a positional-tagging client made the
  // parent look like a thread root, which forks the thread: our reply tags it
  // 'root' while every other participant tags the real root, and the two halves
  // of the conversation stop resolving to each other.
  const rootTag = parentETags.find(t => t[3] === 'root')
    ?? parentETags.find(t => t[3] !== 'mention' && isValidEventId(t[1]));
  const rootId = (rootTag?.[1] && isValidEventId(rootTag[1])) ? rootTag[1] : replyTo.id;

  if (rootId !== replyTo.id) {
    // Forward the root's relay hint and (when the parent recorded it) the root
    // author's pubkey from the parent's own root tag.
    const rootHint = isValidRelayHint(rootTag?.[2]) ? rootTag![2] : '';
    const rootAuthor = isValidPubkey(rootTag?.[4]) ? rootTag![4] : '';
    tags.push(rootAuthor
      ? ['e', rootId, rootHint, 'root', rootAuthor]
      : ['e', rootId, rootHint, 'root']);
  }
  tags.push(['e', replyTo.id, hint, replyTo.id === rootId ? 'root' : 'reply', replyTo.pubkey]);

  // Ancestor chain: parent author first, then the parent's forwarded participants.
  // Each keeps a relay hint where we have one — the parent author's hint is the
  // relay we just resolved for them; everyone else keeps the parent's recorded hint.
  const seen = new Set<string>();
  const participants: Array<[string, string]> = [];
  const add = (pk: unknown, relay: unknown) => {
    if (!isValidPubkey(pk) || seen.has(pk)) return;
    seen.add(pk);
    participants.push([pk, isValidRelayHint(relay) ? relay : '']);
  };
  add(replyTo.pubkey, hint);
  for (const t of replyTo.tags) {
    if (t[0] === 'p') add(t[1], t[2]);
  }
  for (const [pk, relay] of participants) {
    tags.push(relay ? ['p', pk, relay] : ['p', pk]);
  }
  return tags;
}

// ─── NIP-22 comments (kind 1111) ─────────────────────────────────────────────

/** NIP-01 kind ranges. Duplicated here rather than importing NKinds so core
 *  keeps @nostrify as a *type-only* peer dependency. */
function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}
function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** Resolves a relay hint for an author pubkey. Platforms pass their own relay
 *  cache lookup; returning '' (or anything that isn't a ws(s) URL) omits the hint. */
export type RelayHintResolver = (pubkey: string) => string | undefined;

/**
 * Build the scope tags for a NIP-22 comment (kind 1111).
 *
 * NIP-22 splits the reference into an uppercase *root scope* (`E`/`A`/`I` +
 * `K` + `P`) and a lowercase *parent item* (`e`/`a`/`i` + `k` + `p`). A
 * top-level comment repeats the root as its own parent.
 *
 * Every event/address/pubkey reference carries a relay hint where one is known,
 * and `E`/`e` also carry the referenced event's author pubkey — NIP-22 specifies
 * both, and without them a client that doesn't already hold the parent has no
 * way to locate it or attribute it, which is what leaves comment threads showing
 * unresolved placeholders.
 *
 * @param root - The event (or NIP-73 external URL) the whole thread hangs off.
 * @param reply - The specific comment being replied to; omit for a top-level comment.
 * @param hintFor - Optional relay-hint lookup, keyed by author pubkey.
 */
export function buildCommentTags(
  root: NostrEvent | URL,
  reply?: NostrEvent | URL,
  hintFor?: RelayHintResolver,
): string[][] {
  const tags: string[][] = [];
  const hint = (pubkey: string): string => {
    const h = hintFor?.(pubkey);
    return isValidRelayHint(h) ? h : '';
  };

  /** Push the event/address/external reference plus its kind and author tags.
   *  `upper` selects the root scope (E/K/P) vs the parent item (e/k/p). */
  const pushScope = (target: NostrEvent | URL, upper: boolean) => {
    const [E, A, I, K, P] = upper
      ? ['E', 'A', 'I', 'K', 'P']
      : ['e', 'a', 'i', 'k', 'p'];

    if (target instanceof URL) {
      // NIP-73 wants the URL "normalized, no fragment": the fragment is a
      // client-side anchor, so `…/post` and `…/post#comments` are the same
      // external item and must produce the same `i` value or comments on one
      // never surface on the other.
      const url = new URL(target.toString());
      url.hash = '';
      tags.push([I, url.toString()]);
      // NIP-73's k value for a web page is the literal string "web" — NOT the
      // scheme. Emitting "https" here made every URL comment a kind nobody
      // queries for. Non-web schemes have no NIP-73 mapping, so they fall back
      // to the scheme rather than claiming to be a web page. (H5)
      const scheme = target.protocol.replace(/:$/, '');
      tags.push([K, scheme === 'http' || scheme === 'https' ? 'web' : scheme]);
      return;
    }

    const relay = hint(target.pubkey);
    const d = target.tags.find(([name]) => name === 'd')?.[1] ?? '';
    // A/P take the hint as their last element, so a blank one is simply dropped.
    // E must keep position 3 occupied — the author pubkey lives at position 4.
    const addr = isAddressableKind(target.kind)
      ? `${target.kind}:${target.pubkey}:${d}`
      : isReplaceableKind(target.kind)
        ? `${target.kind}:${target.pubkey}:`
        : null;
    if (addr !== null) {
      tags.push(relay ? [A, addr, relay] : [A, addr]);
    } else {
      tags.push([E, target.id, relay, target.pubkey]);
    }
    tags.push([K, target.kind.toString()]);
    tags.push(relay ? [P, target.pubkey, relay] : [P, target.pubkey]);
  };

  pushScope(root, true);
  // A top-level comment's parent IS the root — NIP-22 still requires the
  // lowercase set, so repeat it rather than omitting it.
  pushScope(reply ?? root, false);
  return tags;
}
