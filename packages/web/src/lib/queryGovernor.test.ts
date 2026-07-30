import { describe, it, expect, beforeEach } from 'vitest';
import {
  withQueryBudget,
  acquireQuerySlot,
  bumpQueryEpoch,
  getQueryEpoch,
  isEpochCurrent,
  configureQueryGovernor,
  queryGovernorStats,
  defaultMaxConcurrent,
  lookupPriority,
  StaleEpochError,
  __resetQueryGovernor,
} from '@core/queryGovernor';
import { MissCache } from '@core/missCache';

/** Deferred promise so tests control exactly when a query resolves. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('queryGovernor', () => {
  beforeEach(() => {
    __resetQueryGovernor();
  });

  it('caps concurrent queries at the configured ceiling', async () => {
    configureQueryGovernor({ maxConcurrent: 2 });

    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred<void>());

    const runs = gates.map((gate) =>
      withQueryBudget(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      }),
    );

    // Only the ceiling may be in flight; the rest must be queued.
    await Promise.resolve();
    expect(queryGovernorStats().active).toBe(2);
    expect(queryGovernorStats().queued).toBe(4);

    for (const g of gates) g.resolve();
    await Promise.all(runs);

    expect(peak).toBe(2);
    expect(queryGovernorStats().active).toBe(0);
  });

  it('drops queued work whose epoch was superseded, without running it', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });

    const blocker = deferred<void>();
    const inFlight = withQueryBudget(() => blocker.promise);

    let staleRan = false;
    const epoch = getQueryEpoch();
    const stale = withQueryBudget(async () => { staleRan = true; }, { epoch });

    // User switches tabs — everything queued for the old view is now pointless.
    bumpQueryEpoch();

    await expect(stale).rejects.toBeInstanceOf(StaleEpochError);
    expect(staleRan).toBe(false);

    blocker.resolve();
    await inFlight;
  });

  it('NEVER drops queued work that did not opt into epoch binding', async () => {
    // Cancellation is opt-in on purpose. Backup discovery, contact-list reads
    // and relay-list lookups go through the same governor, and silently
    // rejecting one of those because the user changed tabs mid-flight would
    // turn a performance optimisation into data loss.
    configureQueryGovernor({ maxConcurrent: 1 });

    const blocker = deferred<void>();
    const inFlight = withQueryBudget(() => blocker.promise);

    let unboundRan = false;
    const unbound = withQueryBudget(async () => { unboundRan = true; return 'done'; });

    bumpQueryEpoch();
    bumpQueryEpoch();
    bumpQueryEpoch();

    blocker.resolve();
    await inFlight;

    await expect(unbound).resolves.toBe('done');
    expect(unboundRan).toBe(true);
  });

  it('drops only the epoch-bound waiters, leaving unbound ones queued', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const inFlight = withQueryBudget(() => blocker.promise);

    const epoch = getQueryEpoch();
    const bound = withQueryBudget(async () => 'bound', { epoch });
    const unbound = withQueryBudget(async () => 'unbound');

    bumpQueryEpoch();

    await expect(bound).rejects.toBeInstanceOf(StaleEpochError);
    blocker.resolve();
    await inFlight;
    await expect(unbound).resolves.toBe('unbound');
  });

  it('rejects immediately when the caller queues against an already-stale epoch', async () => {
    const epoch = getQueryEpoch();
    bumpQueryEpoch();

    let ran = false;
    await expect(
      withQueryBudget(async () => { ran = true; }, { epoch }),
    ).rejects.toBeInstanceOf(StaleEpochError);
    expect(ran).toBe(false);
  });

  it('keeps current-epoch work queued across a bump of unrelated work', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const inFlight = withQueryBudget(() => blocker.promise);

    bumpQueryEpoch();
    const current = getQueryEpoch();
    const queued = withQueryBudget(async () => 'ok', { epoch: current });

    expect(isEpochCurrent(current)).toBe(true);
    blocker.resolve();
    await inFlight;
    await expect(queued).resolves.toBe('ok');
  });

  it('releases its slot when the query throws synchronously', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });

    await expect(
      withQueryBudget(() => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(queryGovernorStats().active).toBe(0);
    await expect(withQueryBudget(async () => 'next')).resolves.toBe('next');
  });

  it('releases its slot when the query rejects', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });
    await expect(withQueryBudget(async () => { throw new Error('net'); })).rejects.toThrow('net');
    expect(queryGovernorStats().active).toBe(0);
  });

  it('admits queued work immediately when the ceiling is raised', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const inFlight = withQueryBudget(() => blocker.promise);

    let secondStarted = false;
    const second = withQueryBudget(async () => { secondStarted = true; });

    await Promise.resolve();
    expect(secondStarted).toBe(false);

    configureQueryGovernor({ maxConcurrent: 4 });
    await Promise.resolve();
    expect(secondStarted).toBe(true);

    blocker.resolve();
    await Promise.all([inFlight, second]);
  });

  it('holds a slot across an acquireQuerySlot lifetime and frees it on release', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });

    const release = await acquireQuerySlot();
    expect(queryGovernorStats().active).toBe(1);

    let secondRan = false;
    const second = withQueryBudget(async () => { secondRan = true; });
    await Promise.resolve();
    expect(secondRan).toBe(false); // the generator still holds the only slot

    release();
    await second;
    expect(secondRan).toBe(true);
    expect(queryGovernorStats().active).toBe(0);
  });

  it('makes the acquireQuerySlot release idempotent', async () => {
    configureQueryGovernor({ maxConcurrent: 2 });
    const release = await acquireQuerySlot();
    release();
    release();
    release();
    await Promise.resolve();
    // A double-release would decrement below zero and permanently inflate the
    // effective ceiling — the exact leak a `finally` that runs twice would cause.
    expect(queryGovernorStats().active).toBe(0);

    const gates = [0, 1, 2].map(() => deferred<void>());
    const runs = gates.map(g => withQueryBudget(() => g.promise));
    await Promise.resolve();
    expect(queryGovernorStats().active).toBe(2);
    gates.forEach(g => g.resolve());
    await Promise.all(runs);
  });

  it('denies an acquireQuerySlot queued against a stale epoch', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const inFlight = withQueryBudget(() => blocker.promise);

    const epoch = getQueryEpoch();
    const pending = acquireQuerySlot({ epoch });
    bumpQueryEpoch();

    await expect(pending).rejects.toBeInstanceOf(StaleEpochError);
    blocker.resolve();
    await inFlight;
  });

  it('sizes the default ceiling conservatively on low-core machines', () => {
    // The reported freeze was on a 2-core laptop — headroom matters most there.
    expect(defaultMaxConcurrent(2)).toBe(6);
    expect(defaultMaxConcurrent(4)).toBe(12);
    expect(defaultMaxConcurrent(1)).toBe(4);
    expect(defaultMaxConcurrent(64)).toBe(24);
    expect(defaultMaxConcurrent(undefined)).toBe(12);
  });

  it('serves the high-priority lane before earlier-queued normal work', async () => {
    // The nested-content starvation case: bulk feed chunks queued first must
    // not run ahead of a targeted lookup that arrives after them.
    configureQueryGovernor({ maxConcurrent: 1 });

    const order: string[] = [];
    const blocker = deferred<void>();
    const inFlight = withQueryBudget(async () => { await blocker.promise; });

    const normal = withQueryBudget(async () => { order.push('bulk'); });
    const high = withQueryBudget(async () => { order.push('lookup'); }, { priority: 'high' });

    expect(queryGovernorStats().queuedHigh).toBe(1);
    blocker.resolve();
    await Promise.all([inFlight, normal, high]);
    expect(order).toEqual(['lookup', 'bulk']);
  });

  it('epoch bumps drop stale waiters from BOTH lanes', async () => {
    configureQueryGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const inFlight = withQueryBudget(async () => { await blocker.promise; });

    const epoch = getQueryEpoch();
    const staleHigh = withQueryBudget(async () => 'high', { epoch, priority: 'high' });
    const staleNormal = withQueryBudget(async () => 'normal', { epoch });
    bumpQueryEpoch();

    await expect(staleHigh).rejects.toBeInstanceOf(StaleEpochError);
    await expect(staleNormal).rejects.toBeInstanceOf(StaleEpochError);
    blocker.resolve();
    await inFlight;
  });

  it('classifies targeted lookups high and bulk fan-outs normal', () => {
    // Nested content: events by id, one author's addressable event.
    expect(lookupPriority([{ ids: ['a'.repeat(64)], limit: 1 }])).toBe('high');
    expect(lookupPriority([{ ids: Array.from({ length: 50 }, (_, i) => String(i)) }])).toBe('high');
    expect(lookupPriority([{ kinds: [30023], authors: ['pk'], '#d': ['slug'] }])).toBe('high');
    // Bulk work: author-list feeds, profile batches, open-ended kind queries.
    expect(lookupPriority([{ kinds: [1], authors: Array.from({ length: 500 }, (_, i) => String(i)) }])).toBe('normal');
    expect(lookupPriority([{ kinds: [0], authors: ['pk'] }])).toBe('normal');
    expect(lookupPriority([{ ids: Array.from({ length: 100 }, (_, i) => String(i)) }])).toBe('normal');
    expect(lookupPriority([])).toBe('normal');
    // Mixed sets take the conservative lane.
    expect(lookupPriority([{ ids: ['x'] }, { kinds: [1], authors: ['a', 'b'] }])).toBe('normal');
  });
});

describe('MissCache', () => {
  it('allows the first attempt for an unknown key', () => {
    const c = new MissCache();
    expect(c.shouldRetry('abc')).toBe(true);
  });

  it('blocks retries during the cooldown and allows them after', () => {
    let now = 1_000_000;
    const c = new MissCache({ baseCooldownMs: 1000, now: () => now });

    c.recordMiss('abc');
    expect(c.shouldRetry('abc')).toBe(false);

    now += 999;
    expect(c.shouldRetry('abc')).toBe(false);

    now += 2;
    expect(c.shouldRetry('abc')).toBe(true);
  });

  it('backs off exponentially across consecutive misses', () => {
    let now = 0;
    const c = new MissCache({ baseCooldownMs: 100, maxAttempts: 10, now: () => now });

    c.recordMiss('x');            // cooldown 100
    now += 100;
    expect(c.shouldRetry('x')).toBe(true);

    c.recordMiss('x');            // cooldown 200
    now += 100;
    expect(c.shouldRetry('x')).toBe(false);
    now += 100;
    expect(c.shouldRetry('x')).toBe(true);

    c.recordMiss('x');            // cooldown 400
    now += 300;
    expect(c.shouldRetry('x')).toBe(false);
  });

  it('respects the cooldown ceiling', () => {
    let now = 0;
    const c = new MissCache({ baseCooldownMs: 1000, maxCooldownMs: 2000, maxAttempts: 99, now: () => now });
    for (let i = 0; i < 10; i++) c.recordMiss('x');
    now += 2000;
    expect(c.shouldRetry('x')).toBe(true);
  });

  it('stops retrying entirely after maxAttempts', () => {
    let now = 0;
    const c = new MissCache({ baseCooldownMs: 10, maxAttempts: 3, now: () => now });

    c.recordMiss('gone'); now += 10_000;
    c.recordMiss('gone'); now += 10_000;
    c.recordMiss('gone'); now += 10_000_000;

    // This is the regression that caused the retry storm: an unreachable event
    // must not be re-attempted forever.
    expect(c.shouldRetry('gone')).toBe(false);
  });

  it('clears miss history on a successful lookup', () => {
    const c = new MissCache({ baseCooldownMs: 10_000 });
    c.recordMiss('x');
    expect(c.shouldRetry('x')).toBe(false);
    c.recordHit('x');
    expect(c.shouldRetry('x')).toBe(true);
    expect(c.hasMissed('x')).toBe(false);
  });

  it('evicts oldest entries past maxEntries so the set stays bounded', () => {
    const c = new MissCache({ maxEntries: 3 });
    c.recordMiss('a');
    c.recordMiss('b');
    c.recordMiss('c');
    c.recordMiss('d');

    expect(c.size).toBe(3);
    expect(c.hasMissed('a')).toBe(false);
    expect(c.hasMissed('d')).toBe(true);
  });

  it('filters a candidate list down to retryable keys', () => {
    const now = 0;
    const c = new MissCache({ baseCooldownMs: 1000, now: () => now });
    c.recordMiss('b');

    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(c.retryable(items, i => i.id).map(i => i.id)).toEqual(['a', 'c']);
  });
});
