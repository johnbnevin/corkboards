/**
 * Contact-list (kind 3 / NIP-02) safety helpers — shared by web and mobile.
 *
 * Two hazards this guards against, both of which silently corrupt the follow
 * list (the data users fear losing most):
 *
 *  1. WIPE on relay miss. The contacts query can return [] on a RELAY MISS,
 *     indistinguishable from a genuinely empty follow list. Republishing a
 *     kind 3 built from that empty base would NUKE the user's real follows.
 *     We re-read the authoritative list from relays at action time (network is
 *     up; far more reliable than a stale startup result) and refuse to publish
 *     a removal we can't confirm.
 *
 *  2. METADATA LOSS. NIP-02 `p` tags carry optional extras —
 *     `['p', pubkey, relayURL, petname]`. Rebuilding the list from bare pubkeys
 *     (`['p', pk]`) on every follow/unfollow discards every existing follow's
 *     relay hint and petname, and wiping `content` drops the legacy relay-list
 *     JSON some clients still store there. We therefore preserve the full tag
 *     arrays and the original `content` verbatim, mutating only the one target.
 */
import type { NostrEvent } from '@nostrify/nostrify';

/** Minimal pool shape so any concrete pool (NPool<NRelay>, etc.) is assignable. */
export interface ContactPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (...args: any[]) => Promise<NostrEvent[]>;
}

/**
 * The trustworthy base to republish a kind-3 from: the authoritative event's
 * tags (FULL arrays — relay hints + petnames preserved) and its `content`.
 */
export interface ContactBase {
  /** All tags from the authoritative kind-3, verbatim (preserves p-tag extras). */
  tags: string[][];
  /** The kind-3 content (legacy relay-list JSON some clients store). Preserved. */
  content: string;
}

/** Fetch the user's freshest kind-3 event from relays, or null on relay miss. */
export async function fetchAuthoritativeContactEvent(
  nostr: ContactPool,
  myPubkey: string,
): Promise<NostrEvent | null> {
  try {
    const events = await nostr.query(
      [{ kinds: [3], authors: [myPubkey], limit: 5 }],
      { signal: AbortSignal.timeout(8000) },
    );
    if (events.length > 0) {
      // Kind 3 is replaceable — keep the most recent.
      return events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    }
  } catch {
    /* fall through to caller's fallback */
  }
  return null;
}

/**
 * Resolve the trustworthy base to republish from. Prefers a fresh relay fetch
 * (preserving all p-tag metadata + content); falls back to a non-empty pubkey
 * cache (metadata-less but safe); returns null when the caller must ABORT — a
 * removal with no confirmable list, which would risk a wipe.
 *
 * @param op 'add' tolerates an unconfirmed empty base (new user's first follow);
 *           'remove' refuses to proceed without a confirmed list.
 */
export async function resolveContactBase(
  nostr: ContactPool,
  myPubkey: string,
  cached: string[] | null | undefined,
  op: 'add' | 'remove',
): Promise<ContactBase | null> {
  const event = await fetchAuthoritativeContactEvent(nostr, myPubkey);
  if (event) {
    return { tags: event.tags, content: event.content ?? '' };
  }
  if (cached && cached.length > 0) {
    return { tags: cached.map(pk => ['p', pk]), content: '' };
  }
  if (op === 'add') return { tags: [], content: '' }; // first follow, no list anywhere
  return null; // removal with no confirmable list — caller must abort
}

/** Followed pubkeys from a base, in order (the `p`-tag values). */
export function contactPubkeys(base: ContactBase): string[] {
  return base.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
}

/**
 * Apply a single follow/unfollow to a base, preserving every other follow's
 * tag metadata and the event content. Returns the new kind-3 tags/content plus
 * the resulting pubkey list (for optimistic cache updates), or null when the
 * change is a no-op (already following / already not following).
 */
export function applyContactChange(
  base: ContactBase,
  op: { add?: string; remove?: string },
): { tags: string[][]; content: string; pubkeys: string[] } | null {
  const has = (pk: string) => base.tags.some(t => t[0] === 'p' && t[1] === pk);
  let tags: string[][];
  if (op.add) {
    if (has(op.add)) return null;
    tags = [...base.tags, ['p', op.add]];
  } else if (op.remove) {
    if (!has(op.remove)) return null;
    tags = base.tags.filter(t => !(t[0] === 'p' && t[1] === op.remove));
  } else {
    return null;
  }
  return { tags, content: base.content, pubkeys: tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]) };
}
