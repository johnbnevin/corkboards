import { useEffect, useMemo, useState } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '../lib/NostrProvider';

// Session-scoped caches shared across all callers.
const deletedAuthors = new Set<string>();  // pubkeys confirmed deleted/vanished
const checkedAuthors = new Set<string>();   // pubkeys we've already queried

// checkedAuthors grows by every author the session ever renders, which in a
// days-long sitting is unbounded. FIFO-evict past the cap: an evicted author
// merely becomes eligible for one more best-effort deletion query later.
const MAX_CHECKED_AUTHORS = 5000;
function rememberChecked(pubkey: string): void {
  if (checkedAuthors.size >= MAX_CHECKED_AUTHORS) {
    const oldest = checkedAuthors.values().next().value;
    if (oldest !== undefined) checkedAuthors.delete(oldest);
  }
  checkedAuthors.add(pubkey);
}

/**
 * Does this event mark its author's account as deleted/vanished?
 *  - NIP-62 (kind 62): request to vanish.
 *  - NIP-09 (kind 5): deletion targeting the author's OWN kind-0 profile via an
 *    `a` tag "0:<pubkey>[:d]".
 */
function isProfileDeletion(ev: NostrEvent): boolean {
  if (ev.kind === 62) return true;
  if (ev.kind === 5) {
    return ev.tags.some(t => t[0] === 'a' && typeof t[1] === 'string' && t[1].startsWith(`0:${ev.pubkey}`));
  }
  return false;
}

/**
 * Batched, best-effort detection of deleted/vanished authors for a set of
 * pubkeys (a feed's visible authors). Runs ONE query per new batch, caches for
 * the session, and returns the deleted subset of `pubkeys`. Mirrors web.
 */
export function useDeletedAuthors(pubkeys: string[]): Set<string> {
  const { nostr } = useNostr();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const unchecked = pubkeys.filter(p => p && !checkedAuthors.has(p));
    if (unchecked.length === 0) return;
    let cancelled = false;
    unchecked.forEach(p => rememberChecked(p));
    (async () => {
      let found = false;
      try {
        const CHUNK = 300;
        for (let i = 0; i < unchecked.length; i += CHUNK) {
          const slice = unchecked.slice(i, i + CHUNK);
          const events = await nostr.query(
            [{ kinds: [5, 62], authors: slice }],
            { signal: AbortSignal.timeout(6000) },
          );
          for (const ev of events) {
            if (isProfileDeletion(ev)) { deletedAuthors.add(ev.pubkey); found = true; }
          }
        }
      } catch {
        unchecked.forEach(p => checkedAuthors.delete(p));
      }
      if (found && !cancelled) setVersion(v => v + 1);
    })();
    return () => { cancelled = true; };
  }, [pubkeys, nostr]);

  return useMemo(() => {
    const s = new Set<string>();
    for (const p of pubkeys) if (deletedAuthors.has(p)) s.add(p);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkeys, version]);
}
