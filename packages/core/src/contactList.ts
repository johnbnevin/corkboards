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
  /**
   * Optional streaming read. When present it is PREFERRED over `query`, because
   * it is the only way to tell "the relays answered and the user has no list"
   * apart from "every relay failed" — see {@link fetchAuthoritativeContactEvent}.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req?: (...args: any[]) => AsyncIterable<any>;
}

/**
 * Outcome of reading the user's authoritative kind-3.
 *
 * The distinction between `confirmed-empty` and `unconfirmed` is the whole
 * point: only the former proves the user genuinely has no follow list, and only
 * the former makes it safe to publish a kind-3 built from an empty base.
 */
export type ContactFetchResult =
  | { status: 'found'; event: NostrEvent }
  | { status: 'confirmed-empty' }
  | { status: 'unconfirmed' };

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

/**
 * Kind 3 is replaceable — keep the most recent, applying NIP-01's tie-break
 * (lowest id wins on equal created_at) rather than letting relay response order
 * decide. Two kind-3s can share a timestamp when the user follows twice within
 * a second or edits from two devices; picking the "wrong" one means the NEXT
 * publish is built from a stale base and silently drops whatever the other
 * event added. Matches deduplicateAndSort() in ./feedAlgorithms.ts.
 */
function latestReplaceable(events: NostrEvent[]): NostrEvent {
  return events.reduce((a, b) => {
    if (b.created_at !== a.created_at) return b.created_at > a.created_at ? b : a;
    return b.id < a.id ? b : a;
  });
}

const CONTACT_FILTER = (myPubkey: string) => ({ kinds: [3], authors: [myPubkey], limit: 5 });
const CONTACT_TIMEOUT_MS = 8000;

/**
 * Read the user's freshest kind-3, reporting WHY it came back empty.
 *
 * This is the safety-critical distinction. `NPool.query()` swallows every
 * transport error and returns whatever partial results it has
 * (`node_modules/@nostrify/nostrify/NPool.ts` — `catch { // Skip errors, return
 * partial results. }`), so an empty array from it means EITHER "the user
 * follows nobody" OR "every relay timed out". Treating those the same is how a
 * populated follow list gets replaced by a one-entry kind-3.
 *
 * `req()` exposes the signal `query()` throws away: an `EOSE` is a relay
 * positively telling us it has finished sending everything it has. Reaching
 * EOSE with no events is a CONFIRMED empty list. Timing out, erroring, or being
 * CLOSED without EOSE is UNCONFIRMED, and the caller must not build on it.
 */
export async function fetchAuthoritativeContactEvent(
  nostr: ContactPool,
  myPubkey: string,
): Promise<ContactFetchResult> {
  const filter = CONTACT_FILTER(myPubkey);

  if (typeof nostr.req === 'function') {
    const found: NostrEvent[] = [];
    let sawEose = false;
    try {
      for await (const msg of nostr.req([filter], { signal: AbortSignal.timeout(CONTACT_TIMEOUT_MS) })) {
        if (msg[0] === 'EVENT') {
          const event = msg[2] as NostrEvent;
          // Guard against a relay answering with someone else's list.
          if (event?.kind === 3 && event.pubkey === myPubkey) found.push(event);
        } else if (msg[0] === 'EOSE') {
          sawEose = true;
          break;
        } else if (msg[0] === 'CLOSED') {
          break;
        }
      }
    } catch {
      /* transport failure — fall through to the unconfirmed verdict below */
    }
    if (found.length > 0) return { status: 'found', event: latestReplaceable(found) };
    return sawEose ? { status: 'confirmed-empty' } : { status: 'unconfirmed' };
  }

  // Fallback for pools without req(). query() cannot distinguish empty from
  // failed, so an empty result MUST be reported as unconfirmed — never as a
  // confirmed empty list.
  try {
    const events = await nostr.query([filter], { signal: AbortSignal.timeout(CONTACT_TIMEOUT_MS) });
    const mine = events.filter((e) => e?.kind === 3 && e.pubkey === myPubkey);
    if (mine.length > 0) return { status: 'found', event: latestReplaceable(mine) };
  } catch {
    /* fall through */
  }
  return { status: 'unconfirmed' };
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
  const result = await fetchAuthoritativeContactEvent(nostr, myPubkey);
  if (result.status === 'found') {
    return { tags: result.event.tags, content: result.event.content ?? '' };
  }
  if (cached && cached.length > 0) {
    return { tags: cached.map(pk => ['p', pk]), content: '' };
  }
  // An empty base REPLACES the user's entire follow list, so it is only safe
  // when we positively confirmed there is nothing to replace.
  //
  // This used to be `if (op === 'add') return { tags: [], content: '' }` with a
  // comment calling it the "first follow, no list anywhere" case — but nothing
  // distinguished that from a relay outage. Both callers' contact queries return
  // `[]` on a miss (MultiColumnClient's queryFn logs "zero contacts or relay
  // miss" and returns []; mobile's useContacts returns [] when `!event`), so
  // `cached.length > 0` was false too, and one click on Follow during an outage
  // published a kind-3 containing exactly one p-tag — wiping every follow and
  // the legacy relay-list JSON in `content` that this module exists to preserve.
  if (result.status === 'confirmed-empty' && op === 'add') {
    return { tags: [], content: '' }; // genuine first follow — relays confirmed no list
  }
  return null; // nothing confirmable — caller must abort rather than risk a wipe
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
