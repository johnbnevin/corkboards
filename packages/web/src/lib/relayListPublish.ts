/**
 * relayListPublish — read-modify-write guarded publishing of the user's NIP-65
 * relay list (kind 10002).
 *
 * ## Why this module exists
 *
 * Kind 10002 is REPLACEABLE: the event we publish replaces the user's entire
 * relay list everywhere. And it is the most load-bearing list in the app —
 * the outbox model routes every read and every write through it, so losing it
 * doesn't just lose a setting, it disconnects the user from their own data and
 * makes their notes unfindable to everyone else. It is exactly as dangerous as
 * the kind-3 follow list that `@core/contactList` exists to protect, and it had
 * none of the same protection.
 *
 * The publish paths (Settings' relay editor, the client's relay sync) built the
 * tag list from `config.relayMetadata` — app-local state seeded by a startup
 * query that returns nothing on a relay miss. Publishing from that state on a
 * bad-network day replaced a 10-relay list with whatever local defaults were
 * showing.
 *
 * So, mirroring @core/contactList:
 *
 *  1. RE-READ the authoritative 10002 at action time with confirmed-empty
 *     semantics (`fetchAuthoritativeEvent`), because a network that is up right
 *     now is far more trustworthy than a result cached at startup.
 *  2. MERGE rather than overwrite: relay entries the user did not touch are
 *     preserved verbatim, along with any non-`r` tags other clients wrote and
 *     the event `content`.
 *  3. REFUSE to publish a SHRUNKEN list built from unconfirmed or empty state.
 *     Growing a list from an unconfirmed base is recoverable; shrinking one is
 *     not, and "the relays didn't answer" must never be read as "the user has no
 *     relays".
 *
 * NIP-65 tag shape: `["r", <url>]` = both read and write; `["r", <url>, "read"]`
 * and `["r", <url>, "write"]` mark one direction only.
 *
 * Credit: NIP-65 and the outbox model are mikedilger's; the confirmed-empty
 * read-modify-write pattern this follows is the one in `@core/contactList`.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import { isSecureRelay } from '@core/nostrUtils';
import { normalizeRelay } from '@core/normalizeRelay';
import { fetchAuthoritativeEvent, type AuthoritativePool } from '@/lib/authoritativeEvent';
import { debugLog, debugWarn } from '@/lib/debug';

/** One relay entry as the UI models it. */
export interface RelayListEntry {
  url: string;
  read: boolean;
  write: boolean;
}

export interface PublishRelayListResult {
  /** True only when the merged event was signed AND at least one relay took it. */
  published: boolean;
  /** The merged entries — callers should adopt these as their new local state. */
  entries: RelayListEntry[];
  /** created_at of the published event, for newer-wins local bookkeeping. */
  updatedAt: number;
  /** Set when we refused to publish; a user-showable explanation. */
  refusedReason?: string;
}

/** Parse the `r` tags of a kind-10002 into entries, dropping insecure URLs. */
export function parseRelayListTags(tags: string[][]): RelayListEntry[] {
  const byUrl = new Map<string, RelayListEntry>();
  for (const tag of tags) {
    if (tag[0] !== 'r' || !tag[1]) continue;
    const url = normalizeRelay(tag[1]);
    if (!isSecureRelay(url)) continue;
    const marker = tag[2];
    // No marker means BOTH directions (NIP-65). A second tag for the same URL
    // with the other marker is how some clients express both — union them.
    const entry = byUrl.get(url) ?? { url, read: false, write: false };
    if (!marker) { entry.read = true; entry.write = true; }
    else if (marker === 'read') entry.read = true;
    else if (marker === 'write') entry.write = true;
    else { entry.read = true; entry.write = true; } // unknown marker — don't silently drop the relay
    byUrl.set(url, entry);
  }
  return [...byUrl.values()];
}

/** Render entries back to NIP-65 `r` tags. */
export function relayListEntriesToTags(entries: RelayListEntry[]): string[][] {
  const tags: string[][] = [];
  for (const e of entries) {
    if (!e.read && !e.write) continue; // a relay marked neither is a removal
    if (e.read && e.write) tags.push(['r', e.url]);
    else tags.push(['r', e.url, e.read ? 'read' : 'write']);
  }
  return tags;
}

/**
 * Merge the caller's desired list onto the authoritative one.
 *
 * The caller's entries WIN for URLs they name (that's the edit), and every other
 * relay on the authoritative event is carried through untouched. Explicit
 * removals therefore have to be expressed by the caller passing `removals` —
 * "absent from `desired`" is deliberately NOT a removal, because the commonest
 * cause of a URL being absent from local state is that local state was never
 * populated.
 */
export function mergeRelayLists(
  authoritative: RelayListEntry[],
  desired: RelayListEntry[],
  removals: string[] = [],
): RelayListEntry[] {
  const removed = new Set(removals.map(normalizeRelay));
  const byUrl = new Map<string, RelayListEntry>();
  for (const e of authoritative) byUrl.set(normalizeRelay(e.url), { ...e, url: normalizeRelay(e.url) });
  for (const e of desired) {
    const url = normalizeRelay(e.url);
    if (!isSecureRelay(url)) continue;
    byUrl.set(url, { url, read: e.read, write: e.write });
  }
  for (const url of removed) byUrl.delete(url);
  return [...byUrl.values()].filter(e => e.read || e.write);
}

/** Signer surface we need — any NUser signer satisfies it. */
export interface RelayListSigner {
  signEvent(t: { kind: number; content: string; tags: string[][]; created_at: number }): Promise<NostrEvent>;
}

/** Publishing surface — NPool's `event()`. */
export interface RelayListPublisher {
  event: (event: NostrEvent, opts?: { signal?: AbortSignal }) => Promise<void>;
}

/**
 * Publish the user's NIP-65 list safely.
 *
 * @param desired  entries the user edited/enabled. Merged ONTO the authoritative
 *                 list; URLs not named here are preserved.
 * @param removals URLs the user explicitly removed. Only an explicit removal can
 *                 shrink the list, and only from a CONFIRMED base.
 */
export async function publishRelayList(
  nostr: AuthoritativePool & RelayListPublisher,
  pubkey: string,
  signer: RelayListSigner,
  desired: RelayListEntry[],
  removals: string[] = [],
): Promise<PublishRelayListResult> {
  const result = await fetchAuthoritativeEvent(nostr, pubkey, 10002);

  let baseTags: string[][] = [];
  let baseContent = '';
  let baseEntries: RelayListEntry[] = [];

  if (result.status === 'found') {
    baseTags = result.event.tags;
    baseContent = result.event.content ?? '';
    baseEntries = parseRelayListTags(baseTags);
    debugLog(`[relayList] authoritative kind-10002 found: ${baseEntries.length} relays (created_at=${result.event.created_at})`);
  } else if (result.status === 'unconfirmed') {
    // We know NOTHING. Publishing now could replace a real list with local
    // defaults — the exact wipe @core/contactList refuses for follows. Allow it
    // only if the user is strictly ADDING and there are no removals: the worst
    // case then is a list that is too large, which the user can trim once the
    // network is back. Anything that could shrink is refused outright.
    if (removals.length > 0) {
      debugWarn('[relayList] refusing to publish — removals requested but relay list unconfirmed');
      return {
        published: false,
        entries: desired,
        updatedAt: 0,
        refusedReason: 'Could not read your current relay list from any relay. Removing relays now could wipe the list — try again when you are back online.',
      };
    }
    debugWarn('[relayList] relay list unconfirmed — publishing an additive-only merge');
  } else {
    debugLog('[relayList] relays confirmed the user has no kind-10002 yet');
  }

  const merged = mergeRelayLists(baseEntries, desired, removals);

  if (merged.length === 0) {
    return {
      published: false,
      entries: baseEntries,
      updatedAt: 0,
      refusedReason: 'Refusing to publish an empty relay list — that would disconnect you from your own notes.',
    };
  }

  // Final shrink guard: never let an unconfirmed/empty base produce a list
  // smaller than what we could see. Only a CONFIRMED read may shrink.
  if (result.status !== 'found' && merged.length < baseEntries.length) {
    return {
      published: false,
      entries: baseEntries,
      updatedAt: 0,
      refusedReason: 'Refusing to shrink your relay list built from unconfirmed state.',
    };
  }

  const mergedTags = relayListEntriesToTags(merged);
  // Preserve every NON-`r` tag other clients wrote on the event verbatim. Kind
  // 10002 is theirs as much as ours; dropping unknown tags on each publish is
  // the interop equivalent of the p-tag metadata loss @core/contactList guards.
  const foreignTags = baseTags.filter(t => t[0] !== 'r');

  const created_at = Math.floor(Date.now() / 1000);
  const event = await signer.signEvent({
    kind: 10002,
    content: baseContent,
    tags: [...mergedTags, ...foreignTags],
    created_at,
  });

  try {
    await nostr.event(event, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    debugWarn('[relayList] publish failed on every relay:', err);
    return {
      published: false,
      entries: merged,
      updatedAt: 0,
      refusedReason: 'Your relay list could not be sent to any relay. It was not saved.',
    };
  }

  debugLog(`[relayList] published kind-10002 with ${merged.length} relays`);
  return { published: true, entries: merged, updatedAt: created_at };
}
