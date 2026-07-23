/**
 * Pure relay-scoring helpers — a welshman-inspired abstraction over
 * per-relay quality tracking.
 *
 * Relays that consistently return events are preferred; relays that timeout
 * or return empty get deprioritized. Score decays so a temporarily-broken
 * relay can recover. Relay *selection* itself is handled by
 * `@welshman/router` inside each platform's NostrProvider — this module only
 * holds the shared scoring primitives both platforms feed into it.
 *
 * This module is pure (no DOM, no React, no nostrify); each platform
 * adapts it to its concrete NPool / KVStorage.
 */

import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

// ─── Per-relay score ────────────────────────────────────────────────────────

export interface RelayScore {
  /** Successful event-returning queries since last decay. */
  hits: number;
  /** Timeouts and empty responses since last decay. */
  misses: number;
  /** Last time this score was touched (ms since epoch). */
  touched: number;
}

/** Returns a single number in [0, 1] summarizing relay quality.  Higher = better. */
export function scoreToWeight(s: RelayScore): number {
  const total = s.hits + s.misses;
  if (total === 0) return 0.5; // unknown — neutral
  return s.hits / total;
}

/** Decay aged scores so a recovered relay isn't punished forever. */
export function decayScore(s: RelayScore, halfLifeMs: number, now = Date.now()): RelayScore {
  const elapsed = now - s.touched;
  if (elapsed <= 0) return s;
  const factor = Math.pow(0.5, elapsed / halfLifeMs);
  return {
    hits: s.hits * factor,
    misses: s.misses * factor,
    touched: now,
  };
}

export function recordHit(s: RelayScore | undefined, now = Date.now()): RelayScore {
  if (!s) return { hits: 1, misses: 0, touched: now };
  return { ...s, hits: s.hits + 1, touched: now };
}

export function recordMiss(s: RelayScore | undefined, now = Date.now()): RelayScore {
  if (!s) return { hits: 0, misses: 1, touched: now };
  return { ...s, misses: s.misses + 1, touched: now };
}

// ─── Re-exports for ergonomics ──────────────────────────────────────────────

// Re-export filter types so callers can write `import { NostrFilter } from '@core/router'`
// — keeps the import surface narrow.
export type { NostrEvent, NostrFilter };
