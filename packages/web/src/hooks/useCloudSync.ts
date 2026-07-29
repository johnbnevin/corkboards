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
import { CLOUD_SYNC_INTERVAL_MS, CLOUD_SYNC_MIN_GAP_MS } from '@core/cacheConfig';

// Cadence lives in @core/cacheConfig so web and mobile cannot drift apart.
export { CLOUD_SYNC_INTERVAL_MS } from '@core/cacheConfig';

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
  loadRemoteBackup: (opts?: { silent?: boolean; askOnRemovals?: boolean }) => Promise<{ applied: boolean; heldRemovals?: number }>;
}

export function useCloudSync({
  enabled,
  backupStatus,
  checkRemoteBackup,
  remoteTimestamp,
  lastBackupTs,
  loadRemoteBackup,
}: UseCloudSyncOptions): { syncNow: () => void } {
  const inFlight = useRef(false);
  const lastSyncAt = useRef(0);

  // Read through refs so the interval and listener below can be registered once
  // and still see current values — re-registering on every backup-status change
  // would reset the interval constantly.
  const latest = useRef({ enabled, backupStatus, checkRemoteBackup, remoteTimestamp, lastBackupTs, loadRemoteBackup });
  latest.current = { enabled, backupStatus, checkRemoteBackup, remoteTimestamp, lastBackupTs, loadRemoteBackup };

  const syncNow = useCallback(() => {
    const cur = latest.current;
    if (!cur.enabled || inFlight.current) return;
    if (document.visibilityState === 'hidden') return;
    // Never race a restore or a save that's already running.
    if (cur.backupStatus === 'restoring' || cur.backupStatus === 'checking') return;
    if (Date.now() - lastSyncAt.current < CLOUD_SYNC_MIN_GAP_MS) return;

    inFlight.current = true;
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
        const checked = await cur.checkRemoteBackup(true);
        if (!checked) return;
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
    const t = setTimeout(syncNow, 4000);
    return () => clearTimeout(t);
  }, [enabled, syncNow]);

  // On return to the foreground.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => { if (document.visibilityState === 'visible') syncNow(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, syncNow]);

  // And on an interval while the app is open, so two devices in use at the same
  // time converge without either being touched.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(syncNow, CLOUD_SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, syncNow]);

  // Retry as soon as connectivity returns — the offline case above.
  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => syncNow();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [enabled, syncNow]);

  return { syncNow };
}
