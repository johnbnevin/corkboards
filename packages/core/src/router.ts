/**
 * Pure relay-routing helpers — a welshman-inspired abstraction over the
 * outbox model and per-relay scoring.
 *
 * Design goals (mirrors what `@welshman/router` solves):
 *   - **Scenarios**: every query has a *purpose* (read-follows, write-outbox,
 *     fetch-author, etc.). The router picks relays based on that purpose
 *     instead of the caller hand-rolling a relay list each time.
 *   - **Scoring**: relays that consistently return events for a given
 *     scenario are preferred; relays that timeout or return empty get
 *     deprioritized. Score decays so a temporarily-broken relay can recover.
 *   - **Outbox**: writes go to the author's published write-relays (kind
 *     10002), reads pull from the follows' write-relays plus a small set
 *     of indexer fallbacks.
 *
 * This module is pure (no DOM, no React, no nostrify); each platform
 * adapts it to its concrete NPool / KVStorage.
 */

import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

// ─── Scenarios ──────────────────────────────────────────────────────────────

export type RouterScenario =
  /** Read events written by people the user follows (read tab, all-follows). */
  | 'read-follows'
  /** Read events written by a specific author (profile, friend tab). */
  | 'read-author'
  /** Publish an event to the user's own write relays (outbox). */
  | 'write-outbox'
  /** Fetch a specific event by id (thread, quoted note). */
  | 'fetch-event'
  /** Fetch a profile (kind 0) — usually small set of indexer relays. */
  | 'fetch-profile'
  /** Discovery / global search — wide reach. */
  | 'discover';

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

// ─── Router config ──────────────────────────────────────────────────────────

export interface RouterConfig {
  /** Fallback relays used when no scenario-specific relays are available. */
  fallbacks: readonly string[];
  /** Indexer relays for profile/metadata reads. */
  indexers: readonly string[];
  /** Read-only relays (some platforms ban writes — never route writes here). */
  readOnly: readonly string[];
  /** Max relays returned for any single scenario request. */
  maxRelaysPerQuery: number;
  /** Half-life for score decay. Default 1h. */
  scoreHalfLifeMs: number;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  fallbacks: [],
  indexers: [],
  readOnly: [],
  maxRelaysPerQuery: 5,
  scoreHalfLifeMs: 60 * 60 * 1000,
};

// ─── Relay selection ────────────────────────────────────────────────────────

/**
 * Pick relays for a given scenario from a candidate pool, ranked by score.
 *
 * The caller supplies the candidate pool (e.g. for read-follows that's the
 * union of all followed pubkeys' write-relays; for write-outbox it's the
 * current user's own write-relays). The router only ranks and slices.
 */
export function selectRelays(opts: {
  scenario: RouterScenario;
  candidates: readonly string[];
  scores: ReadonlyMap<string, RelayScore>;
  config: RouterConfig;
  now?: number;
}): string[] {
  const { scenario, candidates, scores, config } = opts;
  const now = opts.now ?? Date.now();

  // Apply read-only filter to write scenarios
  const filtered = scenario === 'write-outbox'
    ? candidates.filter(url => !config.readOnly.includes(url))
    : candidates;

  // Score each candidate (with decay)
  const ranked = filtered.map(url => {
    const raw = scores.get(url);
    const decayed = raw ? decayScore(raw, config.scoreHalfLifeMs, now) : undefined;
    return { url, weight: decayed ? scoreToWeight(decayed) : 0.5 };
  });

  // Sort by weight desc, break ties by URL for determinism
  ranked.sort((a, b) => b.weight - a.weight || a.url.localeCompare(b.url));

  // Top N + fallbacks for resilience
  const picked = ranked.slice(0, config.maxRelaysPerQuery).map(r => r.url);

  // Always include at least one fallback for read scenarios so a
  // brand-new follow with no cached relays still resolves.
  if (scenario !== 'write-outbox' && picked.length < config.maxRelaysPerQuery) {
    for (const f of config.fallbacks) {
      if (picked.length >= config.maxRelaysPerQuery) break;
      if (!picked.includes(f)) picked.push(f);
    }
  }

  return picked;
}

// ─── Filter routing (the part `@welshman/router` calls a "scenario") ───────

/**
 * Group a list of authors by their write-relays so multiple author-specific
 * filters can be batched per relay instead of fanning out one query per
 * (author, relay) pair.
 *
 * Returns Map<relayUrl, authors-using-this-relay>. When `maxAuthorsPerGroup`
 * is given, a relay's author list is split into multiple suffixed entries
 * (`<url>#1`, `<url>#2`, …) so a single relay can't accumulate an unbounded
 * author count that the caller forgets to chunk; strip the `#n` suffix before
 * connecting. Without the cap a relay maps to one (possibly large) list.
 */
export function groupAuthorsByRelay(
  authors: readonly string[],
  authorRelays: ReadonlyMap<string, readonly string[]>,
  fallbacks: readonly string[],
  maxAuthorsPerGroup?: number,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const pubkey of authors) {
    const relays = authorRelays.get(pubkey);
    const targets = (relays && relays.length > 0) ? relays : fallbacks;
    for (const url of targets) {
      const list = groups.get(url) ?? [];
      list.push(pubkey);
      groups.set(url, list);
    }
  }
  if (!maxAuthorsPerGroup || maxAuthorsPerGroup <= 0) return groups;

  const chunked = new Map<string, string[]>();
  for (const [url, list] of groups) {
    if (list.length <= maxAuthorsPerGroup) {
      chunked.set(url, list);
      continue;
    }
    for (let i = 0; i < list.length; i += maxAuthorsPerGroup) {
      const part = list.slice(i, i + maxAuthorsPerGroup);
      chunked.set(i === 0 ? url : `${url}#${i / maxAuthorsPerGroup}`, part);
    }
  }
  return chunked;
}

// ─── Re-exports for ergonomics ──────────────────────────────────────────────

// Re-export filter types so callers can write `import { NostrFilter } from '@core/router'`
// — keeps the import surface narrow.
export type { NostrEvent, NostrFilter };
