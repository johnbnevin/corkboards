/**
 * The pull-check pacing rule: poll while there is something to learn, stop
 * when there demonstrably isn't.
 *
 * A device checks for newer cloud snapshots on a short interval, but after
 * `CLOUD_SYNC_IDLE_STRIKES` consecutive checks that found nothing new it goes
 * quiet (callers keep only a slow heartbeat) — an unattended tab polling
 * relays at full speed forever is exactly the background traffic that has
 * broken working features before. Any sign of life (the app regaining focus,
 * user activity, the network returning, a local save creating something for
 * other devices to react to, or a check that actually found something)
 * resets the count and resumes the fast cadence.
 *
 * Failed checks are NOT strikes: a relay outage looks identical to "nothing
 * new" from the caller's side, and mistaking an outage for idleness would
 * stop checking exactly when retrying matters most.
 */

export type CheckResult = 'found-new' | 'nothing-new' | 'failed'

export type SchedulerResetReason =
  | 'visible'
  | 'focus'
  | 'online'
  | 'app-active'
  | 'activity'
  | 'local-save'
  | 'login'

export interface SyncScheduler {
  /** Record the outcome of a completed check. */
  recordCheckResult(result: CheckResult): void
  /** True when interval ticks should skip checking until the next reset. */
  isIdle(): boolean
  /** Consecutive nothing-new count (for logs/tests). */
  strikes(): number
  /** Something happened — resume checking. */
  reset(reason: SchedulerResetReason): void
}

export function createSyncScheduler(idleAfterStrikes: number): SyncScheduler {
  let strikes = 0
  return {
    recordCheckResult(result: CheckResult) {
      if (result === 'nothing-new') strikes += 1
      else if (result === 'found-new') strikes = 0
      // 'failed' leaves the count where it is — outage is not idleness,
      // but neither is it evidence anyone is active.
    },
    isIdle() {
      return strikes >= idleAfterStrikes
    },
    strikes() {
      return strikes
    },
    reset(_reason: SchedulerResetReason) {
      strikes = 0
    },
  }
}
