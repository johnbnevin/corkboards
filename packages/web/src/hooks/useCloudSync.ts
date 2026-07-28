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
 * Purely additive merges apply silently. A merge that would REMOVE something
 * this device has is never applied behind the user's back; it leaves the
 * existing restore prompt standing instead.
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
  /** Force a check for a newer cloud snapshot; resolves when settled. */
  checkRemoteBackup: (force: boolean) => Promise<void>;
  /** Timestamp of the newest cloud snapshot found by the last check. */
  remoteTimestamp: number | null;
  /** This device's last-synced timestamp. */
  lastBackupTs: number;
  /** Merge the cloud state in. */
  loadRemoteBackup: (opts?: { silent?: boolean; askOnRemovals?: boolean }) => Promise<void>;
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
        await cur.checkRemoteBackup(true);
        const remote = latest.current.remoteTimestamp;
        const local = latest.current.lastBackupTs;
        if (!remote) return;
        // Strictly newer: equal timestamps mean this device wrote it.
        if (local && remote <= local) {
          debugLog(`[cloudSync] cloud ${remote} not newer than local ${local}`);
          return;
        }
        debugLog(`[cloudSync] cloud ${remote} newer than local ${local} — merging`);
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
