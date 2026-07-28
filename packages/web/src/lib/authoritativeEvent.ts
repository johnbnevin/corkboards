/**
 * authoritativeEvent — "did the relays actually answer?" for replaceable events.
 *
 * This is the kind-3 safety pattern from `@core/contactList`
 * (`fetchAuthoritativeContactEvent`) generalized to any replaceable kind, so the
 * other replaceable lists the app rewrites — kind 10000 mutes, kind 10002
 * NIP-65 relays — get the same guarantee instead of each re-deriving it.
 *
 * WHY this exists at all: `NPool.query()` swallows every transport error and
 * returns whatever partial results it has (see the `catch { // Skip errors,
 * return partial results. }` in @nostrify/nostrify's NPool.ts). So an empty
 * array from it means EITHER "the user has no such event" OR "every relay timed
 * out", and those two are indistinguishable at the call site. Replaceable events
 * are REPLACED by the next publish, so building a new event on a base that came
 * back empty for the second reason wipes the real list — the exact failure mode
 * @core/contactList documents for follows, and which pins/mutes/relay lists are
 * equally exposed to.
 *
 * `req()` exposes the signal `query()` throws away: EOSE is a relay positively
 * saying "that is everything I have". Reaching EOSE with no events is a
 * CONFIRMED empty. Timing out, erroring, or being CLOSED without EOSE is
 * UNCONFIRMED, and the caller must refuse to publish rather than risk the wipe.
 */
import type { NostrEvent } from '@nostrify/nostrify';

/** Minimal pool shape so NPool (and the Tauri proxy around it) is assignable. */
export interface AuthoritativePool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (...args: any[]) => Promise<NostrEvent[]>;
  /** Preferred when present — the only way to tell empty from failed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req?: (...args: any[]) => AsyncIterable<any>;
}

export type AuthoritativeResult =
  | { status: 'found'; event: NostrEvent }
  | { status: 'confirmed-empty' }
  | { status: 'unconfirmed' };

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Replaceable events keep the most recent, applying NIP-01's tie-break (lowest
 * id wins on equal created_at) rather than letting relay response order decide.
 * Same rule as @core/contactList's `latestReplaceable`.
 */
function latestReplaceable(events: NostrEvent[]): NostrEvent {
  return events.reduce((a, b) => {
    if (b.created_at !== a.created_at) return b.created_at > a.created_at ? b : a;
    return b.id < a.id ? b : a;
  });
}

/**
 * Read the user's freshest event of `kind`, reporting WHY it came back empty.
 *
 * @param kind a replaceable kind (10000–19999, or 0/3). Addressable kinds need a
 *             `d` tag and are out of scope here.
 */
export async function fetchAuthoritativeEvent(
  nostr: AuthoritativePool,
  pubkey: string,
  kind: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<AuthoritativeResult> {
  const filter = { kinds: [kind], authors: [pubkey], limit: 5 };

  if (typeof nostr.req === 'function') {
    const found: NostrEvent[] = [];
    let sawEose = false;
    try {
      for await (const msg of nostr.req([filter], { signal: AbortSignal.timeout(timeoutMs) })) {
        if (msg[0] === 'EVENT') {
          const event = msg[2] as NostrEvent;
          // Guard against a relay answering with someone else's list.
          if (event?.kind === kind && event.pubkey === pubkey) found.push(event);
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
    const events = await nostr.query([filter], { signal: AbortSignal.timeout(timeoutMs) });
    const mine = events.filter((e) => e?.kind === kind && e.pubkey === pubkey);
    if (mine.length > 0) return { status: 'found', event: latestReplaceable(mine) };
  } catch {
    /* fall through */
  }
  return { status: 'unconfirmed' };
}
