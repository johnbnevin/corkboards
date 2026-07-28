/**
 * Policy for the unresolved-reference retry sweep, shared by web and mobile.
 *
 * The decision of *whether* to sweep is pure and easy to get wrong in three
 * different ways on two platforms, so it lives here with tests rather than
 * being written twice. The platform hooks own the timer, the visibility check
 * and the actual refetch; this owns the rules.
 */

/** How often the sweep may run on its own. */
export const SWEEP_INTERVAL_MS = 30_000

/**
 * Minimum unresolved references before a sweep is worth doing.
 *
 * One stuck reference is usually a note that genuinely isn't on any relay we
 * can reach — retrying it forever is churn the user never sees the benefit of.
 * Two or more suggests something transient (a slow relay, a socket budget that
 * was momentarily exhausted), which is exactly what a retry fixes.
 */
export const MIN_UNRESOLVED_TO_SWEEP = 2

/**
 * Most references retried in one sweep.
 *
 * Uncapped, a page holding hundreds of unresolved references would fire that
 * many lookups at once and re-create the socket starvation the desktop relay
 * lanes exist to prevent — the sweep would then be the reason the next batch
 * fails. The remainder is picked up by the following sweep.
 */
export const MAX_PER_SWEEP = 20

/** Gap between individual retries within a sweep, so they don't burst. */
export const SWEEP_STAGGER_MS = 500

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
