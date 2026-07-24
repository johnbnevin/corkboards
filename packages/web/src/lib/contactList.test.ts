/**
 * Regression tests for kind-3 (NIP-02) follow-list safety in @core/contactList.
 *
 * The bug these pin: `NPool.query()` swallows transport errors and returns
 * partial results, so `[]` means either "user follows nobody" or "every relay
 * failed". `resolveContactBase` used to treat an unconfirmable empty read as a
 * new user's first follow and hand back an EMPTY base — which, published as a
 * replaceable kind-3, replaced the user's entire follow list with a single
 * p-tag. Losing follows is the failure mode this module exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import {
  resolveContactBase,
  applyContactChange,
  fetchAuthoritativeContactEvent,
  contactPubkeys,
  type ContactPool,
} from '@core/contactList';

const ME = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const NEW_FOLLOW = 'c'.repeat(64);

function kind3(tags: string[][], created_at = 1000, content = '', id = '0'.repeat(64)): NostrEvent {
  return { id, pubkey: ME, kind: 3, created_at, tags, content, sig: '' } as NostrEvent;
}

/** Pool whose req() reaches EOSE — a relay positively answered. */
function poolAnswering(events: NostrEvent[]): ContactPool {
  return {
    query: async () => events,
    req: async function* () {
      for (const e of events) yield ['EVENT', 'sub', e];
      yield ['EOSE', 'sub'];
    },
  };
}

/** Pool whose req() never EOSEs — every relay timed out. query() returns [] with
 *  no throw, exactly as NPool does after swallowing the errors. */
function poolFailing(): ContactPool {
  return {
    query: async () => [],
    req: async function* () {
      // no EVENT, no EOSE — the generator just ends, like an aborted stream
    },
  };
}

/** Pool whose req() throws outright (connection refused). */
function poolThrowing(): ContactPool {
  return {
    query: async () => [],
    // eslint-disable-next-line require-yield
    req: async function* () {
      throw new Error('connection refused');
    },
  };
}

describe('fetchAuthoritativeContactEvent', () => {
  it('reports found when a relay returns the list', async () => {
    const ev = kind3([['p', FRIEND]]);
    const res = await fetchAuthoritativeContactEvent(poolAnswering([ev]), ME);
    expect(res.status).toBe('found');
    expect(res.status === 'found' && res.event.id).toBe(ev.id);
  });

  it('reports confirmed-empty only when the relay actually reached EOSE', async () => {
    expect((await fetchAuthoritativeContactEvent(poolAnswering([]), ME)).status).toBe('confirmed-empty');
  });

  it('reports unconfirmed when relays time out or throw', async () => {
    expect((await fetchAuthoritativeContactEvent(poolFailing(), ME)).status).toBe('unconfirmed');
    expect((await fetchAuthoritativeContactEvent(poolThrowing(), ME)).status).toBe('unconfirmed');
  });

  it('reports unconfirmed — never confirmed-empty — for a query-only pool', async () => {
    // Without req() there is no EOSE to observe, so an empty query result is
    // never sufficient evidence that the user has no list.
    const queryOnly: ContactPool = { query: async () => [] };
    expect((await fetchAuthoritativeContactEvent(queryOnly, ME)).status).toBe('unconfirmed');
  });

  it('ignores a kind-3 belonging to somebody else', async () => {
    const foreign = { ...kind3([['p', FRIEND]]), pubkey: FRIEND } as NostrEvent;
    expect((await fetchAuthoritativeContactEvent(poolAnswering([foreign]), ME)).status)
      .toBe('confirmed-empty');
  });

  it('applies the NIP-01 tie-break (lowest id) on equal created_at', async () => {
    const hi = kind3([['p', FRIEND]], 5000, '', 'f'.repeat(64));
    const lo = kind3([['p', NEW_FOLLOW]], 5000, '', '1'.repeat(64));
    const res = await fetchAuthoritativeContactEvent(poolAnswering([hi, lo]), ME);
    expect(res.status === 'found' && res.event.id).toBe('1'.repeat(64));
  });
});

describe('resolveContactBase — wipe protection', () => {
  it('REFUSES an add when relays are unreachable and the cache is empty', async () => {
    // The exact wipe scenario: relay outage + cache `[]` (which is what BOTH
    // platforms' contacts queries return on a miss).
    expect(await resolveContactBase(poolFailing(), ME, [], 'add')).toBeNull();
    expect(await resolveContactBase(poolThrowing(), ME, [], 'add')).toBeNull();
    expect(await resolveContactBase(poolFailing(), ME, undefined, 'add')).toBeNull();
  });

  it('REFUSES a remove when relays are unreachable', async () => {
    expect(await resolveContactBase(poolFailing(), ME, [], 'remove')).toBeNull();
  });

  it('ALLOWS a genuine first follow when relays confirm the list is empty', async () => {
    const base = await resolveContactBase(poolAnswering([]), ME, [], 'add');
    expect(base).toEqual({ tags: [], content: '' });
  });

  it('falls back to a non-empty cache when relays are unreachable', async () => {
    const base = await resolveContactBase(poolFailing(), ME, [FRIEND], 'add');
    expect(contactPubkeys(base!)).toEqual([FRIEND]);
  });

  it('prefers the authoritative event, preserving p-tag extras and content', async () => {
    const ev = kind3([['p', FRIEND, 'wss://relay.example', 'petname']], 1000, '{"wss://x":{}}');
    const base = await resolveContactBase(poolAnswering([ev]), ME, [FRIEND], 'add');
    expect(base!.tags[0]).toEqual(['p', FRIEND, 'wss://relay.example', 'petname']);
    expect(base!.content).toBe('{"wss://x":{}}');
  });
});

describe('applyContactChange', () => {
  it('appends without disturbing existing tag metadata or content', () => {
    const base = { tags: [['p', FRIEND, 'wss://r', 'pet'], ['t', 'topic']], content: 'legacy' };
    const out = applyContactChange(base, { add: NEW_FOLLOW })!;
    expect(out.tags[0]).toEqual(['p', FRIEND, 'wss://r', 'pet']);
    expect(out.tags).toContainEqual(['t', 'topic']);
    expect(out.tags).toContainEqual(['p', NEW_FOLLOW]);
    expect(out.content).toBe('legacy');
    expect(out.pubkeys).toEqual([FRIEND, NEW_FOLLOW]);
  });

  it('removes only the target and keeps every other follow intact', () => {
    const base = { tags: [['p', FRIEND, 'wss://r'], ['p', NEW_FOLLOW]], content: 'legacy' };
    const out = applyContactChange(base, { remove: NEW_FOLLOW })!;
    expect(out.pubkeys).toEqual([FRIEND]);
    expect(out.tags[0]).toEqual(['p', FRIEND, 'wss://r']);
  });

  it('returns null for no-ops so nothing is republished', () => {
    const base = { tags: [['p', FRIEND]], content: '' };
    expect(applyContactChange(base, { add: FRIEND })).toBeNull();
    expect(applyContactChange(base, { remove: NEW_FOLLOW })).toBeNull();
    expect(applyContactChange(base, {})).toBeNull();
  });
});
