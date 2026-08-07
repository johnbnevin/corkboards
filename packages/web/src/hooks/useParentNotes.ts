import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { type NostrEvent } from '@nostrify/nostrify';
import { fetchEventWithOutbox } from '@/lib/fetchEvent';
import { MissCache } from '@core/missCache';
import { registerUnresolved, clearUnresolved } from '@core/failedNotes';

// Shared cache for parent notes (persists across hook instances).
//
// BOUNDED. It was a plain unbounded Map: every reply the user ever scrolled
// past added a full event object (content, tags, sig) and nothing ever removed
// one, so a long autofetch session — the normal way this app is used — grew it
// until the tab was reloaded. `parentMisses` next to it is already bounded for
// exactly this reason; the hit cache needs the same treatment, and more so,
// because it stores whole events rather than counters.
// 1500 was low enough to thrash: the result map is built by READING this cache
// (see the queryFn), so a parent evicted while still on screen resolves to
// null → grey placeholder → the sweep refetches it → its re-insert evicts
// another on-screen parent. Every event in that loop is perfectly fetchable.
// A long autofetch session passes 1500 distinct parents easily. 4000 events of
// this shape is a few MB — cheap next to re-querying relays forever.
const MAX_PARENT_NOTE_CACHE = 4000;
const parentNoteCache = new Map<string, NostrEvent>();

/** LRU insert: re-inserting moves a key to the end of Map iteration order. */
export function cacheParentNote(id: string, event: NostrEvent): void {
  parentNoteCache.delete(id);
  while (parentNoteCache.size >= MAX_PARENT_NOTE_CACHE) {
    parentNoteCache.delete(parentNoteCache.keys().next().value!);
  }
  parentNoteCache.set(id, event);
}

/**
 * Negative cache for IDs the fast batch pass didn't find.
 *
 * This used to be a plain `Set<string>` that only ever grew: an id was added
 * when the first pass missed and removed only if a later pass found the event.
 * Any genuinely-unreachable parent — deleted, or living only on a relay we
 * don't talk to — therefore stayed in it for the life of the process.
 *
 * The second-pass effect below re-reads it whenever `query.data` changes, which
 * is every feed update: every autofetch tick, every "load newer", every tab
 * switch. So each of those re-armed a full second pass over every permanently
 * missing id, forever, and got worse as the feed grew. On desktop one
 * second-pass lookup opens roughly a dozen fresh TLS connections (pool fan-out
 * + NIP-65 discovery across all fallback relays + author relays), so a feed
 * with a few dozen unreachable parents became a standing load generator.
 *
 * MissCache keeps the retry — late-arriving data must still resolve — but makes
 * it decay: exponential cooldown per consecutive miss, a hard attempt ceiling,
 * and a bounded entry count.
 */
const parentMisses = new MissCache({
  maxEntries: 2000,
  baseCooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  maxAttempts: 3,
});

/**
 * Ids the most recent FIRST pass attempted and did not resolve — the second
 * pass's actual work queue.
 *
 * The second-pass filter used to be `hasMissed(id) && shouldRetry(id)`, which
 * is self-defeating right after a first pass: a pass that TIMED OUT records no
 * miss (so `hasMissed` is false), and a pass that reached EOSE and missed just
 * started a 30s cooldown (so `shouldRetry` is false). Either way the 800ms
 * escalation found nothing to do, and parents only got author-relay discovery
 * if some LATER refetch happened after the cooldown — the "second pass
 * sometimes fixes it, sometimes the whole page stays unresolved" behaviour,
 * worst on desktop where first passes time out most.
 *
 * An id in this set earned exactly one prompt escalation by being attempted by
 * a first pass (itself gated by the miss cooldown), so draining it does not
 * recreate the retry storm; the attempt ceiling still applies via isExhausted.
 */
const pendingSecondPass = new Set<string>();

// Limit concurrent first-pass pool queries to avoid opening too many relay connections at once.
const MAX_CONCURRENT_POOL_QUERIES = 6;

// First-pass pool query ceiling. EOSE usually resolves well before this; the
// ceiling just bounds the worst case before missing IDs fall to the second pass.
const FIRST_PASS_TIMEOUT_MS = 6000;
/**
 * How long the id lookup keeps listening after the FIRST relay EOSEs.
 *
 * NPool.query hard-codes 1s here (and overrides any per-call value), which for
 * an id lookup is exactly backwards: the fast relay that answers first is the
 * one that DOESN'T have an old parent, and the slow archive relay that does
 * have it gets cut off 1s later. That deterministic truncation is why a
 * missing parent failed the same way on every retry. Sits inside
 * FIRST_PASS_TIMEOUT_MS, so the worst case is unchanged. Kept at 2.5s (not
 * higher): each first pass fans out to up to 8 relays that each hold a
 * global governor slot for the subscription's lifetime, so this window is
 * paid from the SAME shared budget as feed/profile/backup queries — long
 * enough to stop truncating slow archives, short enough not to own the
 * governor.
 */
const ID_LOOKUP_EOSE_TIMEOUT_MS = 2500;
// Delay before the second (outbox-discovery) pass. Kept short so reply parents
// that the first pass missed appear quickly instead of seconds later.
const SECOND_PASS_DELAY_MS = 800;
/** Max individual outbox lookups fired by one second pass. */
const MAX_SECOND_PASS_PER_ROUND = 12;
let _activePoolQueries = 0;
const _poolQueryQueue: Array<() => void> = [];

function withPoolQueryLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (_activePoolQueries < MAX_CONCURRENT_POOL_QUERIES) {
    _activePoolQueries++;
    return fn().finally(() => {
      _activePoolQueries--;
      _poolQueryQueue.shift()?.();
    });
  }
  return new Promise<T>((resolve, reject) => {
    _poolQueryQueue.push(() => {
      _activePoolQueries++;
      fn().then(resolve, reject).finally(() => {
        _activePoolQueries--;
        _poolQueryQueue.shift()?.();
      });
    });
  });
}

interface ParentRequest {
  eventId: string;
  hints?: string[];
  authorPubkey?: string;
  /** Other thread participants (p-tags) — fallback outbox candidates when
   *  authorPubkey is wrong or missing; the parent's author is guaranteed by
   *  NIP-10 to be among them. */
  candidateAuthors?: string[];
}

/**
 * Fetch a single parent note by event ID using outbox model.
 */
export function useParentNote(eventId: string | undefined) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['parent-note', eventId],
    queryFn: async () => {
      if (!eventId) return null;
      if (parentNoteCache.has(eventId)) return parentNoteCache.get(eventId)!;

      const result = await fetchEventWithOutbox(eventId, nostr);
      if (result) cacheParentNote(eventId, result);
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: !!eventId,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

/**
 * Batch fetch multiple parent notes.
 *
 * First pass: fast batch query via the NPool (uses built-in outbox routing).
 * Second pass (3s later): any IDs still missing are retried individually
 * via fetchEventWithOutbox which does full author-relay discovery.
 */
export function useParentNotes(requests: (ParentRequest | string)[]) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const secondPassScheduled = useRef(false);

  // Stable content signature of the request set. The memos below (and the
  // second-pass effect) key off this so they only recompute when the actual IDs
  // change — not on every render. Previously these arrays were rebuilt every
  // render, so the second-pass effect (which lists uniqueRequests as a dep)
  // re-ran constantly, arming-and-cancelling its timer and leaving genuinely-
  // missing parents blank.
  const cacheKey = useMemo(() => {
    const ids = requests
      .map(r => (typeof r === 'string' ? r : r?.eventId))
      .filter((id): id is string => !!id && id.length > 0);
    return Array.from(new Set(ids)).sort().join(',');
  }, [requests]);

  const uniqueRequests = useMemo<ParentRequest[]>(() => {
    const normalized: ParentRequest[] = requests.map(r =>
      typeof r === 'string' ? { eventId: r } : r
    );
    return Array.from(
      new Map(normalized.filter(r => r.eventId?.length > 0).map(r => [r.eventId, r])).values()
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on cacheKey, the content signature of `requests`
  }, [cacheKey]);

  const uniqueIds = useMemo(() => uniqueRequests.map(r => r.eventId), [uniqueRequests]);
  const queryKey = useMemo(() => ['parent-notes', cacheKey], [cacheKey]);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (uniqueRequests.length === 0) {
        return {} as Record<string, NostrEvent | null>;
      }

      // Find which IDs need to be fetched: not cached, and not inside a miss
      // cooldown. Without the second condition the *first* pass re-queried every
      // known-unreachable id on every feed update too, not just the second.
      const uncachedIds = uniqueIds.filter(
        id => !parentNoteCache.has(id) && parentMisses.shouldRetry(id),
      );

      // Age out exhausted miss entries whose final cooldown has long elapsed.
      // Nothing ever called prune(), so an id that spent its 3 attempts during
      // one congested startup stayed retired for the LIFETIME of the session —
      // no sweep, no refetch, nothing could ever revive it.
      parentMisses.prune();

      // First pass: fast batch query through the pool.
      //
      // Driven through nostr.req(), not nostr.query(), for two reasons that
      // are each sufficient on their own:
      //  1. query() swallows aborts and returns partial results as if the
      //     relays had answered — so a TIMED OUT pass looked "completed" and
      //     recorded authoritative misses for every id, advancing reachable
      //     parents toward the 3-attempt ceiling during plain congestion.
      //     req() lets us see whether EOSE actually arrived.
      //  2. query() force-overrides the per-call eoseTimeout with the pool
      //     default (1s after the first relay EOSEs) — see
      //     ID_LOOKUP_EOSE_TIMEOUT_MS above.
      if (uncachedIds.length > 0) {
        let passCompleted = false;
        try {
          await withPoolQueryLimit(async () => {
            if (signal.aborted) return;
            const combined = AbortSignal.any([signal, AbortSignal.timeout(FIRST_PASS_TIMEOUT_MS)]);
            try {
              for await (const msg of nostr.req(
                [{ ids: uncachedIds }],
                { signal: combined, eoseTimeout: ID_LOOKUP_EOSE_TIMEOUT_MS },
              )) {
                if (msg[0] === 'EVENT') cacheParentNote(msg[2].id, msg[2]);
                else if (msg[0] === 'EOSE') { passCompleted = true; break; }
                else if (msg[0] === 'CLOSED') break;
              }
            } catch (err) {
              // The pool only yields the merged EOSE when EVERY routed relay
              // EOSEs; when its per-call eoseTimeout expires first it ABORTS
              // the iterator instead. One dead relay in the read list (a very
              // common topology) would therefore make every pass look
              // incomplete and disable miss recording for the whole session.
              // Disambiguate by who aborted: if OUR combined signal did not
              // fire, the abort was the pool's own eoseTimeout — which only
              // arms after the FIRST relay EOSEs — so every relay that was
              // going to answer had answered, plus a grace window. That is
              // completion. Our own signal firing (outer timeout, unmount)
              // stays incomplete.
              if (!combined.aborted) passCompleted = true;
              else throw err;
            }
          });
        } catch {
          // Aborted or transport failure — evidence of congestion, not of
          // absence. passCompleted stays false so no misses are recorded, and
          // all IDs become candidates for the second pass.
        }

        // Track which IDs are still missing after pool query — but a query
        // that TIMED OUT or was aborted is evidence of congestion, not of
        // absence. Recording misses for it advanced each id's exponential
        // cooldown toward the attempt ceiling, so a busy startup could retire
        // dozens of reachable parents for up to 15 minutes — the "way too many
        // notes without their nested content, and no background pass fixes
        // them" failure. Only a query that actually reached EOSE gets to say
        // an id wasn't there.
        for (const id of uncachedIds) {
          if (parentNoteCache.has(id)) {
            parentMisses.recordHit(id);
            pendingSecondPass.delete(id);
          } else {
            if (passCompleted) parentMisses.recordMiss(id);
            // Attempted just now and still missing — timed out or genuinely
            // absent, the second pass escalates either way. This hand-off is
            // what makes the second pass fire AFTER a first pass instead of
            // being blocked by the very cooldown that first pass just started.
            pendingSecondPass.add(id);
          }
        }
      }

      // Build result map from cache, and tell the retry sweep about anything
      // still missing.
      //
      // The sweep's registry was populated only by NoteLink — i.e. quoted notes
      // in a note's CONTENT. Replied-to parents live on this path instead, so
      // they were never swept: once `parentMisses` spent its three attempts the
      // id was retired and the preview stayed blank for the rest of the session,
      // no matter how many notes arrived afterwards. That is exactly the
      // "replied-to note never renders, even after a retry" case. Registering
      // here puts parents under the same periodic retry as quoted notes, and
      // the sweep clears their miss decay before re-querying.
      const result: Record<string, NostrEvent | null> = {};
      for (const id of uniqueIds) {
        result[id] = parentNoteCache.get(id) || null;
        if (result[id]) clearUnresolved(id); else registerUnresolved(id);
      }
      return result;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: uniqueIds.length > 0,
    placeholderData: keepPreviousData,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  // Keep the retry sweep's registry in sync with what is ON SCREEN.
  //
  // Registration used to happen only inside the queryFn — so when TanStack
  // served the batch from its 5-minute cache (remount, tab switch, a second
  // feed column asking for the same ids) the queryFn never ran, the grey
  // placeholders rendered from cached nulls, and the sweep saw ZERO
  // unresolved ids: no background retry ever fired for exactly the notes the
  // user was staring at. The registry must reflect the rendered result, not
  // the fetch path that produced it. Cleared on unmount so the sweep stays
  // scoped to the current page (clearUnresolved is idempotent).
  useEffect(() => {
    if (!query.data) return;
    for (const id of uniqueIds) {
      if (query.data[id]) clearUnresolved(id); else registerUnresolved(id);
    }
    return () => { for (const id of uniqueIds) clearUnresolved(id); };
  }, [query.data, uniqueIds]);

  // Second pass: retry failed IDs individually with full outbox discovery
  //
  // Keyed on dataUpdatedAt, NOT data identity. When a retry sweep re-runs the
  // batched query and every id misses again, the result map is deep-equal to
  // the previous one, so structural sharing hands back the SAME object — an
  // effect keyed on `query.data` never re-fires, and the escalation below (the
  // lookup that actually finds these events) ran once at mount and never
  // again. dataUpdatedAt advances on every completed fetch regardless.
  const dataUpdatedAt = query.dataUpdatedAt;
  useEffect(() => {
    if (secondPassScheduled.current) return;
    if (!query.data) return;

    // Two ways in: an id the first pass JUST attempted and left unresolved
    // (pendingSecondPass — retried now even inside its cooldown, since the
    // cooldown was started by that same first pass), or an older miss whose
    // cooldown has elapsed. The attempt ceiling is respected in both branches —
    // that is what stops the standing retry storm.
    const missing = uniqueRequests
      .filter(r => pendingSecondPass.has(r.eventId)
        ? !parentMisses.isExhausted(r.eventId)
        : (parentMisses.hasMissed(r.eventId) && parentMisses.shouldRetry(r.eventId)))
      // Bound a single pass regardless of feed size: a large feed used to fire
      // Promise.all over every missing parent at once, and each of those opens
      // ~a dozen sockets on desktop. Anything beyond the cap is picked up by a
      // later pass once these resolve.
      .slice(0, MAX_SECOND_PASS_PER_ROUND);
    if (missing.length === 0) return;

    secondPassScheduled.current = true;
    let mounted = true;
    const timer = setTimeout(async () => {
      // Consumed exactly when the escalation actually fires. If the timer is
      // cancelled (unmount, feed change) the ids stay pending for the next run.
      for (const r of missing) pendingSecondPass.delete(r.eventId);
      let found = 0;
      const results = await Promise.all(
        missing.map(r =>
          fetchEventWithOutbox(r.eventId, nostr, {
            hints: r.hints,
            authorPubkey: r.authorPubkey,
            candidateAuthors: r.candidateAuthors,
          }).catch(() => null)
        )
      );

      if (!mounted) return;

      for (let i = 0; i < missing.length; i++) {
        if (results[i]) {
          cacheParentNote(missing[i].eventId, results[i]!);
          parentMisses.recordHit(missing[i].eventId);
          found++;
        } else {
          // Still not found — advance the backoff so the next round waits
          // longer, and the attempt ceiling eventually stops the retries.
          parentMisses.recordMiss(missing[i].eventId);
        }
      }

      if (found > 0) {
        queryClient.invalidateQueries({ queryKey });
      }
      secondPassScheduled.current = false;
    }, SECOND_PASS_DELAY_MS);

    return () => {
      mounted = false;
      clearTimeout(timer);
      secondPassScheduled.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataUpdatedAt stands in for query.data (see above)
  }, [dataUpdatedAt, uniqueRequests, nostr, queryClient, queryKey]);

  return query;
}

/**
 * Check if a parent note is already cached.
 */
export function isParentNoteCached(eventId: string): boolean {
  return parentNoteCache.has(eventId);
}

/**
 * Get a cached parent note (returns undefined if not cached).
 */
export function getCachedParentNote(eventId: string): NostrEvent | undefined {
  return parentNoteCache.get(eventId);
}

/**
 * Clear the parent note cache.
 */
export function clearParentNoteCache(): void {
  parentNoteCache.clear();
  parentMisses.clear();
  pendingSecondPass.clear();
}

/**
 * Forget one id's miss history so the next lookup actually goes to the relays.
 *
 * The retry sweep (useUnresolvedRetry) needs this: an id that has missed a few
 * times is inside its exponential cooldown, or has spent its attempt budget, so
 * re-querying would be answered from the negative cache with the same "not
 * found" — a sweep that looks like it ran and changed nothing. An explicit
 * retry is new information (the relay set or the socket budget may have
 * recovered), so it resets the decay for that id only.
 */
export function forgetParentMiss(eventId: string): void {
  parentMisses.recordHit(eventId);
}
