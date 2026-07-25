/**
 * missCache — bounded, expiring negative cache for "we looked and didn't find it".
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `useParentNotes` tracked failed lookups in a module-level `Set<string>` that
 * was only ever added to. An event id landed in it when the fast batch query
 * missed, and left it only if a later pass found the event — so any genuinely
 * unreachable parent (deleted, or living only on a relay we don't talk to)
 * stayed in the set for the lifetime of the process.
 *
 * That set was re-read on every change to the parent-note query data, which
 * changes on every feed update. So each autofetch tick, each "load newer", each
 * tab switch re-armed a full second pass over every permanently-missing id —
 * and on desktop a single second-pass lookup opens ~13 fresh TLS connections
 * (pool fan-out + NIP-65 discovery across all fallback relays + author relays).
 *
 * A feed with 40 unreachable parents therefore re-attempted 40 lookups, forever,
 * every few seconds, and got slower as the feed grew. Retrying is right; retrying
 * without limit or decay is a self-inflicted load generator.
 *
 * This module makes a miss a first-class, decaying fact: remember it, back off
 * on repeat, and eventually forget so genuinely-late data still resolves.
 *
 * Pure/platform-agnostic — no DOM, no storage, no React. `now` is injectable so
 * tests don't sleep.
 */

export interface MissCacheOptions {
  /** Entries to retain before evicting the oldest. */
  maxEntries?: number;
  /** Base cooldown after the first miss (ms). Doubles per consecutive miss. */
  baseCooldownMs?: number;
  /** Ceiling on the exponential cooldown (ms). */
  maxCooldownMs?: number;
  /**
   * After this many consecutive misses, stop retrying entirely until the entry
   * ages out of the cache. Some events are simply gone.
   */
  maxAttempts?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

interface MissEntry {
  attempts: number;
  /** Epoch ms before which a retry is pointless. */
  retryAfter: number;
}

const DEFAULTS = {
  maxEntries: 2000,
  baseCooldownMs: 30_000,     // 30 s after the first miss
  maxCooldownMs: 30 * 60_000, // cap at 30 min
  maxAttempts: 4,
};

export class MissCache {
  private entries = new Map<string, MissEntry>();
  private readonly maxEntries: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(opts: MissCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULTS.maxEntries;
    this.baseCooldownMs = opts.baseCooldownMs ?? DEFAULTS.baseCooldownMs;
    this.maxCooldownMs = opts.maxCooldownMs ?? DEFAULTS.maxCooldownMs;
    this.maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record a failed lookup. Each consecutive miss doubles the cooldown, so a
   * genuinely-unreachable id costs 30 s, then 1 min, then 2 min… and after
   * `maxAttempts` stops being retried at all.
   */
  recordMiss(key: string): void {
    const existing = this.entries.get(key);
    const attempts = (existing?.attempts ?? 0) + 1;
    const cooldown = Math.min(
      this.baseCooldownMs * Math.pow(2, attempts - 1),
      this.maxCooldownMs,
    );
    // Re-insert so Map iteration order stays least-recently-updated first,
    // which is what the eviction below relies on.
    this.entries.delete(key);
    this.entries.set(key, { attempts, retryAfter: this.now() + cooldown });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Clear a key's miss history — call when the lookup finally succeeds. */
  recordHit(key: string): void {
    this.entries.delete(key);
  }

  /**
   * True when a retry is worth making right now: either we've never missed on
   * this key, or its cooldown has elapsed and it hasn't exhausted its attempts.
   */
  shouldRetry(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    if (entry.attempts >= this.maxAttempts) return false;
    return this.now() >= entry.retryAfter;
  }

  /** True when the key has been missed at least once and is still on record. */
  hasMissed(key: string): boolean {
    return this.entries.has(key);
  }

  /** Filter a candidate list down to the keys worth retrying now. */
  retryable<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
    return items.filter(item => this.shouldRetry(keyOf(item)));
  }

  /** Drop expired entries. Optional — `shouldRetry` is correct without it. */
  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      // Only reclaim exhausted entries once they're well past their last
      // cooldown, so "stop retrying" doesn't silently become "retry again".
      if (entry.attempts >= this.maxAttempts && now >= entry.retryAfter + this.maxCooldownMs) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
