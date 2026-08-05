/**
 * Policy for the unresolved-reference retry sweep, shared by web and mobile.
 *
 * The decision of *whether* to sweep is pure and easy to get wrong in three
 * different ways on two platforms, so it lives here with tests rather than
 * being written twice. The platform hooks own the timer, the visibility check
 * and the actual refetch; this owns the rules.
 */

/** How often the sweep may run on its own.
 *
 *  Back to 30s from 15s. The 15s value was chosen while the sweep was
 *  effectively idle (unresolved references were never registered, so it had
 *  almost nothing to retry). Once registration was fixed the sweep suddenly
 *  had up to MAX_PER_SWEEP real ids every round, and at 15s with a 325ms
 *  stagger it was firing for ~13 of every 15 seconds — an 85% duty cycle on a
 *  socket budget shared with the feed, profile fetches and cloud-backup
 *  discovery. It starved the backup manifest query badly enough that every
 *  relay appeared dead ("6 of 6 didn't respond") and, being the aggressor,
 *  starved its own lookups too. A retry that prevents its own success is not
 *  a retry. */
export const SWEEP_INTERVAL_MS = 30_000

/**
 * Minimum unresolved references before a sweep is worth doing.
 *
 * Was 2, reasoning that one stuck reference is probably genuinely unreachable.
 * In practice the user stares at exactly that one gray box: once the per-id
 * miss decay hits its attempt ceiling, nothing but the sweep can revive it, so
 * a threshold of 2 turned "one unresolved note" into "unresolved forever".
 * The miss decay already bounds the retry cost of a truly-dead reference.
 */
export const MIN_UNRESOLVED_TO_SWEEP = 1

/**
 * Most references retried in one sweep.
 *
 * Uncapped, a page holding hundreds of unresolved references would fire that
 * many lookups at once and re-create the socket starvation the desktop relay
 * lanes exist to prevent — the sweep would then be the reason the next batch
 * fails. The remainder is picked up by the following sweep.
 *
 * Cut 40 → 12. Each id's retry is not one socket: it fans out through
 * fetchEventWithOutbox to pool legs plus author-relay discovery (~8 more
 * sockets), so 40 per round meant dozens of concurrent connections
 * continuously. 12 ids over a 30s interval leaves the shared budget usable by
 * the feed and by cloud-backup discovery — which is what makes the retries
 * themselves succeed.
 */
export const MAX_PER_SWEEP = 12

/** Gap between individual retries within a sweep, so they don't burst. */
export const SWEEP_STAGGER_MS = 500

/**
 * Sweep attempts per id before the registry gives up on it.
 *
 * Without a ceiling, a reference that is genuinely unreachable (deleted event,
 * relay that no longer exists) is retried every round for as long as it stays
 * on screen — a desktop session left open for days ran the sweep thousands of
 * times against the same dead ids, churning sockets and allocations the whole
 * time. Ten attempts at the 30s interval gives a flaky relay ~5 minutes of
 * chances, which covers every transient failure the sweep exists for. The
 * record is unmount-scoped: navigating away and back starts the count fresh,
 * so "given up" means "for this sitting", not forever.
 */
export const MAX_SWEEP_ATTEMPTS = 10

export interface SweepDecisionInput {
  /** How many references are unresolved on screen right now. */
  unresolvedCount: number
  /** True when a sweep is already running. */
  inFlight: boolean
  /** True when the app is backgrounded / the tab is hidden. */
  hidden: boolean
  /** Now, in ms. */
  now: number
  /** When the last sweep started, in ms; 0 if none has run. */
  lastSweepAt: number
  /** Minimum gap between sweeps. Defaults to SWEEP_INTERVAL_MS. */
  minGapMs?: number
}

export type SweepDecision =
  | { sweep: true }
  | { sweep: false; reason: 'in-flight' | 'hidden' | 'below-threshold' | 'too-soon' }

/**
 * Whether a sweep should run now.
 *
 * Both triggers — the interval and a new-notes fetch — go through this, which
 * is what makes "must not overlap another attempt" true rather than aspirational:
 * a fetch that lands next to a tick is refused as `too-soon`/`in-flight` instead
 * of doubling the work.
 */
export function shouldSweep(input: SweepDecisionInput): SweepDecision {
  const { unresolvedCount, inFlight, hidden, now, lastSweepAt } = input
  const minGapMs = input.minGapMs ?? SWEEP_INTERVAL_MS

  if (inFlight) return { sweep: false, reason: 'in-flight' }
  // Never retry into a backgrounded app. Same rule as autofetch, for the same
  // reason: a hidden tab retrying on a timer produced 231 overnight failures.
  if (hidden) return { sweep: false, reason: 'hidden' }
  if (unresolvedCount < MIN_UNRESOLVED_TO_SWEEP) return { sweep: false, reason: 'below-threshold' }
  if (lastSweepAt > 0 && now - lastSweepAt < minGapMs) return { sweep: false, reason: 'too-soon' }
  return { sweep: true }
}

/** The slice of ids a single sweep should attempt. */
export function selectSweepBatch(ids: readonly string[]): string[] {
  return ids.slice(0, MAX_PER_SWEEP)
}
