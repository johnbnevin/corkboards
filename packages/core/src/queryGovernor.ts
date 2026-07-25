/**
 * queryGovernor — a single, global ceiling on concurrent relay work.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Every feature that touches the network had its OWN concurrency cap:
 *
 *   fetchEvent.ts        MAX_CONCURRENT_OUTBOX_FETCHES  (4 web / 8 desktop)
 *   useParentNotes.ts    MAX_CONCURRENT_POOL_QUERIES    (6)
 *   useBulkAuthors.ts    (none — Promise.all over every batch)
 *   useAuthor.ts         (none — 5 parallel races per uncached profile)
 *   useFeedPagination.ts (none)
 *   useThreadQuery.ts    (none)
 *
 * Each cap is locally sensible and globally meaningless: they compose by
 * MULTIPLICATION, not by addition. A screenful of all-follows notes fans out to
 * parent lookups + reaction targets + repost targets + profile prefetch + the
 * feed query itself, and every one of those subsystems is independently "under
 * its limit" while the machine is opening hundreds of TLS connections at once.
 *
 * On a 2-core laptop that is not a slow feed — it is an unresponsive desktop,
 * because relay work is not free-and-waiting: each connection costs a DNS
 * lookup, a TCP handshake, and a TLS handshake (asymmetric crypto), and each
 * returned event costs a schnorr verification. That is CPU, and it competes
 * with the compositor for the same two cores.
 *
 * So: one governor, one ceiling, every relay query goes through it. Subsystem
 * caps stay as sub-limits (they usefully stop one feature from monopolising the
 * budget) but the global ceiling is what makes the machine's worst case
 * bounded and predictable.
 *
 * ─── Epochs (cancellation) ──────────────────────────────────────────────────
 *
 * Rapid tab switching used to stack complete query sets: nothing cancelled the
 * previous tab's work, so three fast clicks meant three full fan-outs in flight
 * and only the last one's results were ever displayed. `bumpQueryEpoch()` marks
 * everything older as irrelevant — queued work is dropped before it starts
 * (never begins), and in-flight work sees `isEpochCurrent` go false and can
 * bail out of its own post-processing.
 *
 * Pure/platform-agnostic — no DOM, no React, no storage. Web, desktop and
 * mobile all import this same module so the ceiling is genuinely global and
 * the three platforms cannot drift.
 */

/** Thrown by `withQueryBudget` when work is dropped because its epoch is stale. */
export class StaleEpochError extends Error {
  constructor() {
    super('query dropped: superseded by a newer epoch');
    this.name = 'StaleEpochError';
  }
}

export interface QueryGovernorOptions {
  /**
   * Max concurrent relay queries across the whole app.
   *
   * Sized against cores, not bandwidth — the binding constraint is CPU for
   * TLS handshakes and signature verification, not the network. A 2-core
   * machine gets 6; a 16-core desktop gets 24.
   */
  maxConcurrent: number;
}

/**
 * Pick a ceiling from the host's core count.
 *
 * Deliberately conservative at the low end: the reported whole-machine freeze
 * was on a 2-core Athlon Silver, where the webview's main thread, its
 * compositor, and the relay work all contend for the same two cores. Leaving
 * headroom there matters more than saturating a big desktop.
 */
export function defaultMaxConcurrent(cores: number | undefined): number {
  const c = typeof cores === 'number' && cores > 0 ? cores : 4;
  return Math.max(4, Math.min(24, c * 3));
}

let _maxConcurrent = 12;
let _active = 0;
let _epoch = 0;

/**
 * Waiters, each tagged with the epoch it was queued in — or `null` for work
 * that is NOT tied to a view and must therefore never be cancelled.
 *
 * The distinction is load-bearing. Most relay reads belong to whatever the user
 * is currently looking at and are pure waste once they navigate away. But some
 * reads are not: cloud-backup discovery, contact-list reads, relay-list lookups.
 * Silently rejecting one of those because the user happened to change tabs at
 * the wrong moment would turn a performance optimisation into data loss, so
 * epoch binding is strictly opt-in.
 */
interface Waiter {
  epoch: number | null;
  start: () => void;
  drop: () => void;
}
const _queue: Waiter[] = [];

/** Configure the global ceiling. Call once at app start. */
export function configureQueryGovernor(opts: QueryGovernorOptions): void {
  _maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
  // A raised ceiling should admit already-queued work immediately rather than
  // waiting for an unrelated in-flight query to finish and pump the queue.
  pump();
}

/**
 * Invalidate all queued-but-not-started work.
 *
 * Call on tab switch, feed switch, and account switch. In-flight queries are
 * NOT killed (their sockets are already open and their CPU already spent —
 * abandoning them mid-handshake wastes the work without freeing the core), but
 * they can check `isEpochCurrent()` before doing expensive post-processing.
 *
 * Returns the new epoch.
 */
export function bumpQueryEpoch(): number {
  _epoch += 1;
  // Drop every waiter from a superseded epoch. `epoch === null` means the work
  // opted out of cancellation and is always kept. Remove from the queue BEFORE
  // rejecting: `drop()` settles a promise, and a caller's catch handler can
  // synchronously re-enter this module to queue new work.
  const isStale = (w: Waiter) => w.epoch !== null && w.epoch !== _epoch;
  const stale = _queue.filter(isStale);
  if (stale.length > 0) {
    for (let i = _queue.length - 1; i >= 0; i--) {
      if (isStale(_queue[i])) _queue.splice(i, 1);
    }
    for (const w of stale) w.drop();
  }
  return _epoch;
}

/** Current epoch — capture before async work, compare after. */
export function getQueryEpoch(): number {
  return _epoch;
}

/** True when `epoch` is still the active one (i.e. the work is still wanted). */
export function isEpochCurrent(epoch: number): boolean {
  return epoch === _epoch;
}

function pump(): void {
  while (_active < _maxConcurrent) {
    const next = _queue.shift();
    if (!next) return;
    // A waiter can go stale between being queued and being pumped. `null` opted
    // out of cancellation and always runs.
    if (next.epoch !== null && next.epoch !== _epoch) {
      next.drop();
      continue;
    }
    next.start();
  }
}

function release(): void {
  _active--;
  pump();
}

/**
 * Run `fn` under the global concurrency ceiling.
 *
 * @param fn      the relay query to run
 * @param opts.epoch
 *   Tie this work to a specific epoch (capture it with `getQueryEpoch()`). If
 *   the epoch is superseded before the query STARTS, it is dropped with a
 *   `StaleEpochError` and never runs — which is the entire point: work for a tab
 *   the user already left should cost nothing.
 *
 *   OMIT IT and the work is never cancelled, only queued. That is the correct
 *   default: cloud-backup discovery, contact-list reads and relay-list lookups
 *   must not be silently dropped because the user changed tabs mid-flight.
 *   Cancellation is opt-in precisely so that a performance optimisation can
 *   never turn into data loss.
 */
export function withQueryBudget<T>(
  fn: () => Promise<T>,
  opts?: { epoch?: number },
): Promise<T> {
  const epoch = opts?.epoch ?? null;

  if (epoch !== null && epoch !== _epoch) {
    return Promise.reject(new StaleEpochError());
  }

  if (_active < _maxConcurrent) {
    _active++;
    // `fn()` may throw synchronously — route that through the same release path
    // rather than leaking a permanently-held slot.
    let p: Promise<T>;
    try {
      p = fn();
    } catch (e) {
      release();
      return Promise.reject(e);
    }
    return p.finally(release);
  }

  return new Promise<T>((resolve, reject) => {
    _queue.push({
      epoch,
      start: () => {
        _active++;
        let p: Promise<T>;
        try {
          p = fn();
        } catch (e) {
          release();
          reject(e);
          return;
        }
        // Release BEFORE settling the caller's promise, not after.
        //
        // `p.then(resolve, reject).finally(release)` looks equivalent but isn't:
        // it resolves the caller a microtask before the slot is given back, so
        // code that awaits a query and immediately queues the next one sees a
        // ceiling that is still fully occupied. Over a burst that under-uses the
        // budget and makes `queryGovernorStats()` lie about what's in flight.
        p.then(
          (v) => { release(); resolve(v); },
          (e) => { release(); reject(e); },
        );
      },
      drop: () => reject(new StaleEpochError()),
    });
  });
}

/**
 * Manual acquire/release, for work that isn't shaped like a single promise —
 * chiefly `req()` async generators, which hold a socket open across many yields
 * and so must hold their slot for the generator's whole lifetime.
 *
 * The returned release function is idempotent; callers should invoke it from a
 * `finally` so an early `break` (the common case — consumers break on EOSE)
 * still frees the slot.
 */
export function acquireQuerySlot(opts?: { epoch?: number }): Promise<() => void> {
  return new Promise<() => void>((granted, denied) => {
    // Hand withQueryBudget a task that resolves only when the caller releases.
    // That way the slot accounting — including the queue, the epoch check, and
    // the decrement — stays in ONE place rather than being reimplemented here.
    let finishTask!: () => void;
    const held = new Promise<void>((resolve) => { finishTask = resolve; });

    void withQueryBudget(() => {
      // Reached only once a slot is actually held.
      let released = false;
      granted(() => {
        if (released) return; // idempotent: `finally` may fire more than once
        released = true;
        finishTask();         // settles `held` → withQueryBudget releases the slot
      });
      return held;
    }, opts).catch(denied);   // dropped by a stale epoch, or fn threw
  });
}

/** Live counters — for the diagnostics panel and tests. */
export function queryGovernorStats(): {
  active: number;
  queued: number;
  maxConcurrent: number;
  epoch: number;
} {
  return { active: _active, queued: _queue.length, maxConcurrent: _maxConcurrent, epoch: _epoch };
}

/** Test-only reset. Not used in app code. */
export function __resetQueryGovernor(): void {
  _active = 0;
  _epoch = 0;
  _queue.length = 0;
  _maxConcurrent = 12;
}
