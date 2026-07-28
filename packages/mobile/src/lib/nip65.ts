/**
 * NIP-65 (kind 10002) relay-list parsing — one implementation, used everywhere.
 *
 * NIP-65 is explicit: an `r` tag carries an OPTIONAL `read` or `write` marker,
 * and "if the marker is omitted, the relay is both read and write". Downloading
 * events *from* a user SHOULD use that user's **write** relays.
 *
 * Three call sites had each rolled their own parse and all three dropped the
 * marker, caching every listed relay as an outbox. The failure that produces is
 * quiet and expensive: a user who lists a read-only inbox (the common shape —
 * a cheap relay for mentions, a paid one for their own notes) had that inbox
 * queried for their notes, which returns nothing, so their posts looked missing
 * while the app burned a connection per author per query on relays that can
 * never answer. NostrSync had the only correct parser; this is that logic,
 * shared, so the three read paths can't drift from it again.
 */

export interface Nip65Relay {
  url: string;
  read: boolean;
  write: boolean;
}

/** Relays advertise wss:// only; a long value is a malformed tag, not a relay. */
export function isValidRelayUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 256) return false;
  try { return new URL(url).protocol === 'wss:'; } catch { return false; }
}

/** Parse the `r` tags of a kind-10002 event into read/write flags. */
export function parseNip65Relays(tags: readonly string[][]): Nip65Relay[] {
  const parsed: Nip65Relay[] = [];
  for (const [name, url, marker] of tags) {
    if (name !== 'r' || !isValidRelayUrl(url)) continue;
    parsed.push({
      url,
      read: !marker || marker === 'read',
      write: !marker || marker === 'write',
    });
  }
  return parsed;
}

/**
 * The relays to READ a user's own events from — their outbox.
 *
 * Unmarked (both) and `write`-marked entries only; `read`-marked inboxes are
 * excluded because the author does not publish there.
 */
export function nip65OutboxRelays(tags: readonly string[][], max: number): string[] {
  return parseNip65Relays(tags)
    .filter((relay) => relay.write)
    .map((relay) => relay.url)
    .slice(0, max);
}
