/**
 * useCloudSync — keep this device on the newest state across all devices.
 *
 * ## What this replaces
 *
 * Restore used to be fenced behind two heuristics, both of which existed only
 * because restore was a wholesale overwrite and could destroy work:
 *
 *   - auto-restore only when local looked empty (no corkboards, no tab filters)
 *   - suggest a restore only after 5 minutes of true idle, and only when the
 *     cloud had more than 5 additional dismissed notes
 *
 * Neither is about being up to date; both are about not losing data. The result
 * was a device that would sit next to a two-minute-old cloud snapshot and do
 * nothing, because the *dismissed count* hadn't moved enough — which is exactly
 * the "phone never picks up the desktop's state" complaint.
 *
 * Now that applying is a merge (see @core/stateMerge), being wrong costs
 * nothing: id sets union, corkboards merge per board, and deletions travel as
 * tombstones. So the rule is simply "is the cloud newer than what we last
 * saw" — checked on load, on return to the foreground, and on an interval.
 *
 * Purely additive merges apply silently, and so do small tombstone-driven
 * removals (deliberate deletions made on another device — propagating them IS
 * the sync working). Only a merge that would remove more than
 * SILENT_REMOVAL_LIMIT items is held back, leaving the restore prompt standing
 * for the user to confirm a mass deletion.
 */
import { useCallback, useEffect, useRef } from 'react';
import { debugLog } from '@/lib/debug';
import { getLastCheckSummary } from '@/hooks/useNostrBackup';
import { CLOUD_SYNC_INTERVAL_MS, CLOUD_SYNC_MIN_GAP_MS, CLOUD_SYNC_IDLE_STRIKES } from '@core/cacheConfig';
import { createSyncScheduler, type SchedulerResetReason } from '@core/syncScheduler';

// Cadence lives in @core/cacheConfig so web and mobile cannot drift apart.
export { CLOUD_SYNC_INTERVAL_MS } from '@core/cacheConfig';

/**
 * The 3-strike idle stop: after CLOUD_SYNC_IDLE_STRIKES consecutive checks
 * that found nothing new, interval ticks stop checking until something happens
 * (focus, visibility, network return, a local save). This is what makes the
 * 30-second interval NET CHEAPER than the old always-on 60-second loop — an
 * unattended tab goes quiet instead of polling forever. Module-level because
 * there is one logical sync loop per app, and the auto-save path (a different
 * hook) must be able to reset it when a local save gives peers something new.
 */
const _scheduler = createSyncScheduler(CLOUD_SYNC_IDLE_STRIKES);

/** Resume idle-stopped checking — call on any sign of life. */
export function resetCloudSyncIdle(reason: SchedulerResetReason): void {
  _scheduler.reset(reason);
}

export interface UseCloudSyncOptions {
  /** Whether a user is logged in. */
  enabled: boolean;
  /** Current backup status — skip while a restore or check is mid-flight. */
  backupStatus: string;
  /** Force a check for a newer cloud snapshot; resolves with the newest remote
   *  snapshot timestamp (null when none/failed). */
  checkRemoteBackup: (force: boolean) => Promise<number | null>;
  /** Timestamp of the newest cloud snapshot found by the last check. */
  remoteTimestamp: number | null;
  /** This device's last-synced timestamp. */
  lastBackupTs: number;
  /** Merge the cloud state in; resolves with whether it actually applied. */
  loadRemoteBackup: (opts?: { silent?: boolean; askOnRemovals?: boolean }) => Promise<{ applied: boolean; heldRemovals?: number; error?: string }>;
}

/**
 * A sync attempt that has not settled in this long is presumed dead.
 *
 * Both guards below are permanent wedges without it. `inFlight` is cleared in
 * a `finally`, which never runs if an await inside never settles (a NIP-46
 * signer that goes silent does exactly that) — and then every later tick
 * returns at the guard, forever. Likewise a `backupStatus` stuck at 'checking'
 * because that same check never finished. The reported symptom is stark: the
 * device "never even looks" for a new state again, with nothing in the UI to
 * say why.
 */
const SYNC_STALE_MS = 90_000;

export function useCloudSync({
  enabled,
  backupStatus,
  checkRemoteBackup,
  remoteTimestamp,
  lastBackupTs,
  loadRemoteBackup,
}: UseCloudSyncOptions): { syncNow: () => void } {
  const inFlight = useRef(false);
  const inFlightSince = useRef(0);
  const statusBlockedSince = useRef(0);
  const lastSyncAt = useRef(0);

  // Read through refs so the interval and listener below can be registered once
  // and still see current values — re-registering on every backup-status change
  // would reset the interval constantly.
  const latest = useRef({ enabled, backupStatus, checkRemoteBackup, remoteTimestamp, lastBackupTs, loadRemoteBackup });
  latest.current = { enabled, backupStatus, checkRemoteBackup, remoteTimestamp, lastBackupTs, loadRemoteBackup };

  const syncNow = useCallback((resetReason?: SchedulerResetReason) => {
    const cur = latest.current;
    if (!cur.enabled) return;
    if (document.visibilityState === 'hidden') return;
    if (resetReason) _scheduler.reset(resetReason);
    else if (_scheduler.isIdle()) {
      // Interval tick with nothing to learn: three consecutive checks found
      // nothing new, so stay quiet until a back-from-idle signal resets us.
      return;
    }
    if (inFlight.current) {
      if (Date.now() - inFlightSince.current < SYNC_STALE_MS) return;
      debugLog('[cloudSync] previous sync never settled — starting a fresh one');
      inFlight.current = false;
    }
    // Never race a restore or a save that's already running — but do not take
    // that status on faith forever. A check that hung leaves 'checking' set,
    // and honouring it indefinitely is what stops the device looking again.
    if (cur.backupStatus === 'restoring' || cur.backupStatus === 'checking') {
      if (statusBlockedSince.current === 0) statusBlockedSince.current = Date.now();
      if (Date.now() - statusBlockedSince.current < SYNC_STALE_MS) return;
      debugLog(`[cloudSync] backupStatus stuck at '${cur.backupStatus}' — syncing anyway`);
    }
    statusBlockedSince.current = 0;
    if (Date.now() - lastSyncAt.current < CLOUD_SYNC_MIN_GAP_MS) return;

    inFlight.current = true;
    inFlightSince.current = Date.now();
    lastSyncAt.current = Date.now();

    (async () => {
      try {
        // Use the RETURNED timestamp, not React state: state set inside the
        // check hasn't re-rendered into `latest` by the time this continuation
        // runs, so the old read compared against the previous tick's value —
        // null on the first sync after load, which skipped the merge that the
        // check had just found. (The state read stays as a fallback.)
        // Non-null means: the newest manifest on the relays is one this device
        // has not already published or merged. That identity check lives in
        // checkRemoteBackup and replaces the timestamp comparison that used to
        // be here — a device whose clock said it was ahead (see the removed
        // stamp-now heuristic) would refuse to pull forever.
        // Bounded: an unsettled signer/relay promise must not hold the
        // in-flight flag (and therefore every future tick) hostage.
        const checked = await Promise.race([
          cur.checkRemoteBackup(true),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_STALE_MS)),
        ]);
        if (!checked) {
          // Nothing new is a strike toward the idle stop; a FAILED check is
          // not — an outage must not be mistaken for idleness.
          const summary = getLastCheckSummary();
          _scheduler.recordCheckResult(summary?.failed ? 'failed' : 'nothing-new');
          return;
        }
        _scheduler.recordCheckResult('found-new');
        debugLog(`[cloudSync] cloud manifest ${checked} not yet merged here — merging`);
        // Let React commit the check's setRemoteBackup before loading:
        // loadRemoteBackup reads remoteBackup from its own closure, and the
        // pre-commit closure still has the previous (possibly null) value.
        await new Promise((r) => setTimeout(r, 100));
        await latest.current.loadRemoteBackup({ silent: true, askOnRemovals: true });
      } catch (err) {
        // Offline or relays unreachable: local stays authoritative until the
        // next attempt. This is the only case where local "wins", and only
        // because there is nothing to merge with.
        _scheduler.recordCheckResult('failed');
        debugLog('[cloudSync] sync failed (will retry):', err);
      } finally {
        inFlight.current = false;
      }
    })();
  }, []);

  // On load — the moment that matters most for a device that was wiped or has
  // been away. Delayed slightly so it doesn't compete with first paint.
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => syncNow('login'), 4000);
    return () => clearTimeout(t);
  }, [enabled, syncNow]);

  // On return to the foreground — resets the idle stop and checks immediately
  // (still under the CLOUD_SYNC_MIN_GAP_MS floor, so app-switch flapping can't
  // hammer relays).
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => { if (document.visibilityState === 'visible') syncNow('visible'); };
    // visibilitychange alone misses focus moving between two visible windows.
    const onFocus = () => syncNow('focus');
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, syncNow]);

  // And on an interval while the app is open, so two devices in use at the same
  // time converge without either being touched. Ticks pass no reason, so the
  // 3-strike idle stop applies to them alone.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => syncNow(), CLOUD_SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, syncNow]);

  // Retry as soon as connectivity returns — the offline case above.
  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => syncNow('online');
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [enabled, syncNow]);

  return { syncNow };
}
